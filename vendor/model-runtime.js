(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.ModelRuntime = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const FORMULA_CACHE = new Map();

  function formConfig(model) {
    return model?.form || {};
  }

  function evaluationConfig(model) {
    return model?.evaluation || {};
  }

  function scoringConfig(model) {
    return evaluationConfig(model).scoring || {};
  }

  function reportingConfig(model) {
    return model?.reporting || {};
  }

  function metricsConfig(model) {
    return evaluationConfig(model).metrics || {};
  }

  function collectionsConfig(model) {
    const evaluation = evaluationConfig(model);
    return evaluation.collections || {};
  }

  function answerValues(model) {
    return evaluationConfig(model).answer_values || {};
  }

  function collection(model, name) {
    return collectionsConfig(model)[name] || evaluationConfig(model)[name] || [];
  }

  function getQuestions(model) {
    return (formConfig(model).sections || []).flatMap((section) =>
      (section.questions || []).map((question) => ({ section, question }))
    );
  }

  function questionMap(model) {
    return new Map(getQuestions(model).map((item) => [item.question.id, item]));
  }

  function normalizeAnswerIds(rawValue) {
    if (rawValue == null) return [];
    return Array.isArray(rawValue) ? rawValue : [rawValue];
  }

  function dedupe(items) {
    return Array.from(new Set(items));
  }

  function textLibraryById(model) {
    const map = new Map();
    const visit = (node) => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (!node || typeof node !== "object") return;
      if (typeof node.id === "string" && typeof node.text === "string") {
        map.set(node.id, node.text);
      }
      Object.values(node).forEach(visit);
    };
    visit(reportingConfig(model).text_library || {});
    return map;
  }

  function resolveBranches(model, answers) {
    const branches = new Set();
    getQuestions(model).forEach(({ question }) => {
      normalizeAnswerIds(answers?.[question.id]).forEach((answerId) => {
        const answer = (question.answers || []).find((entry) => entry.id === answerId);
        (answer?.branch_tags || []).forEach((tag) => branches.add(tag));
      });
    });
    return branches;
  }

  function isQuestionVisible(question, activeBranches) {
    const anyRequired = question.display_condition?.branches_any;
    const allRequired = question.display_condition?.branches_all;
    if (
      Array.isArray(anyRequired) &&
      anyRequired.length &&
      !anyRequired.some((branch) => activeBranches.has(branch))
    ) {
      return false;
    }
    if (
      Array.isArray(allRequired) &&
      allRequired.length &&
      !allRequired.every((branch) => activeBranches.has(branch))
    ) {
      return false;
    }
    return true;
  }

  function visibleQuestions(model, answers, options = {}) {
    const branches = options.activeBranches || resolveBranches(model, answers);
    return getQuestions(model).filter(({ question }) => {
      if (!options.includeInternal && question.internal_only) return false;
      return isQuestionVisible(question, branches);
    });
  }

  function requiredQuestionCoverage(model, answers) {
    const activeBranches = resolveBranches(model, answers);
    const contract = reportingConfig(model).generation_contract;
    if (!contract) return { required: [], missing: [], ready: true };

    const refs = new Set();
    const questions = questionMap(model);
    (contract.required_inputs || []).forEach((requirement) => {
      const questionIds = [...(requirement.question_refs || [])];
      if (requirement.question_refs_from) {
        collectPathValues(evaluationConfig(model), requirement.question_refs_from).forEach((questionId) =>
          questionIds.push(questionId)
        );
      }
      questionIds.forEach((questionId) => {
        const item = questions.get(questionId);
        if (!item || item.question.internal_only) return;
        if (requirement.only_if_displayed && !isQuestionVisible(item.question, activeBranches)) return;
        refs.add(questionId);
      });
    });

    const required = Array.from(refs);
    const missing = required.filter((questionId) => answers?.[questionId] === undefined);
    return { required, missing, ready: !missing.length };
  }

  function createRowsForQuestion(item, answers, options = {}) {
    const selectedIds = normalizeAnswerIds(answers?.[item.question.id]);
    const values = answerValues(options.model);
    return selectedIds
      .map((answerId) => {
        const answer = (item.question.answers || []).find((entry) => entry.id === answerId);
        if (!answer) return null;
        const state = answer.answer_state || "profile_only";
        return {
          question_id: item.question.id,
          answer_id: answer.id,
          question: item.question,
          answer,
          label: answer.label,
          question_text: item.question.question_text,
          section_id: item.section.id,
          section_title: item.section.title,
          section_weight: Number(item.section.weight || 0),
          question_weight: Number(item.question.question_weight || 1),
          answer_state: state,
          answer_value: values[state] ?? null,
          internal_only: Boolean(item.question.internal_only)
        };
      })
      .filter(Boolean);
  }

  function answerRows(model, answers, options = {}) {
    const branches = options.activeBranches || resolveBranches(model, answers);
    const questions = questionMap(model);
    let items;

    if (Array.isArray(options.questionIds) && options.questionIds.length) {
      items = dedupe(options.questionIds)
        .map((questionId) => questions.get(questionId))
        .filter(Boolean);
    } else if (options.scope === "active_questions") {
      items = visibleQuestions(model, answers, { includeInternal: true, activeBranches: branches });
    } else if (options.scope === "active_customer_questions" || !options.scope) {
      items = visibleQuestions(model, answers, { includeInternal: false, activeBranches: branches });
    } else {
      throw new Error(`scope non supportato: ${options.scope}`);
    }

    return items.flatMap((item) => {
      if (!options.includeHidden && !isQuestionVisible(item.question, branches)) return [];
      if (!options.includeInternal && item.question.internal_only) return [];
      return createRowsForQuestion(item, answers, { model });
    });
  }

  function matchingBand(bands, score) {
    if (!Number.isFinite(score)) return null;
    const ordered = [...(bands || [])].sort((a, b) => a.min - b.min);
    return (
      ordered.find((band, index) => {
        const next = ordered[index + 1];
        if (next) return score >= band.min && score < next.min;
        return score >= band.min && score <= band.max;
      }) || null
    );
  }

  function bandForMetric(model, metricId, score) {
    const metricConfig = metricsConfig(model)[metricId] || scoringConfig(model)[metricId] || {};
    return matchingBand(metricConfig.bands || metricConfig.classes || [], score);
  }

  function compareValues(a, b, direction) {
    if (a === b) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return direction === "desc" ? (a < b ? 1 : -1) : a > b ? 1 : -1;
  }

  function toMapper(fnOrField, fallback) {
    if (typeof fnOrField === "function") return fnOrField;
    if (typeof fnOrField === "string") return (item) => item?.[fnOrField];
    return fallback || ((item) => item);
  }

  function sum(items, mapper) {
    const map = toMapper(mapper, (item) => item);
    return (items || []).reduce((total, item, index) => total + Number(map(item, index) || 0), 0);
  }

  function count(items, predicate) {
    if (typeof predicate !== "function") return (items || []).length;
    return (items || []).reduce((total, item, index) => total + (predicate(item, index) ? 1 : 0), 0);
  }

  function average(items, mapper) {
    if (!items || !items.length) return null;
    return sum(items, mapper) / items.length;
  }

  function rowWeight(row, mode) {
    if (typeof mode === "function") return Number(mode(row) || 0);
    if (mode === "section_x_question" || mode === "section_weight_x_question_weight") {
      return Number(row.section_weight || 0) * Number(row.question_weight || 0);
    }
    if (mode === "question_weight" || mode === "question" || !mode) {
      return Number(row.question_weight || 0);
    }
    if (typeof mode === "string") return Number(row[mode] || 0);
    return Number(row.question_weight || 0);
  }

  function weightedAverage(items, options = {}) {
    const rows = (items || []).filter(Boolean);
    const excludeStates = new Set(options.excludeStates || ["na", "profile_only"]);
    const value = toMapper(options.value || "answer_value");
    const weightMode = options.weight || "question_weight";
    let numerator = 0;
    let denominator = 0;

    rows.forEach((row, index) => {
      if (excludeStates.has(row.answer_state)) return;
      const rawValue = Number(value(row, index));
      if (!Number.isFinite(rawValue)) return;
      const weight = rowWeight(row, weightMode);
      numerator += rawValue * weight;
      denominator += weight;
    });

    return denominator ? (numerator / denominator) * 100 : null;
  }

  function min(items, mapper) {
    if (!items || !items.length) return null;
    const map = toMapper(mapper, (item) => item);
    return items.reduce((current, item, index) => {
      const value = map(item, index);
      return current == null || value < current ? value : current;
    }, null);
  }

  function max(items, mapper) {
    if (!items || !items.length) return null;
    const map = toMapper(mapper, (item) => item);
    return items.reduce((current, item, index) => {
      const value = map(item, index);
      return current == null || value > current ? value : current;
    }, null);
  }

  function unique(items, mapper) {
    const map = toMapper(mapper, (item) => item);
    return dedupe((items || []).map((item, index) => map(item, index)));
  }

  function sortBy(items, mapper, direction) {
    const map = toMapper(mapper, (item) => item);
    return [...(items || [])].sort((a, b) => compareValues(map(a), map(b), direction));
  }

  function round(value, digits) {
    if (!Number.isFinite(Number(value))) return value;
    const precision = Number.isInteger(digits) ? digits : 0;
    return Number(Number(value).toFixed(precision));
  }

  function clamp(value, lower, upper) {
    return Math.max(lower, Math.min(upper, value));
  }

  function coalesce() {
    for (let index = 0; index < arguments.length; index += 1) {
      if (arguments[index] !== undefined && arguments[index] !== null) return arguments[index];
    }
    return null;
  }

  function intersects(left, right) {
    const rightSet = new Set(right || []);
    return (left || []).some((item) => rightSet.has(item));
  }

  function resolvePath(source, path) {
    if (!path) return source;
    return String(path)
      .split(".")
      .reduce((current, part) => (current == null ? undefined : current[part]), source);
  }

  function collectPathValues(source, path) {
    const parts = String(path || "")
      .split(".")
      .filter(Boolean);
    return collectNestedValues(source, parts);
  }

  function collectNestedValues(source, parts) {
    if (!parts.length) {
      if (Array.isArray(source)) return source.flatMap((item) => collectNestedValues(item, []));
      return source == null ? [] : [source];
    }
    if (Array.isArray(source)) {
      return source.flatMap((item) => collectNestedValues(item, parts));
    }
    if (!source || typeof source !== "object") return [];
    return collectNestedValues(source[parts[0]], parts.slice(1));
  }

  function countBy(items, mapper) {
    const map = toMapper(mapper, (item) => item);
    return (items || []).reduce((accumulator, item, index) => {
      const key = map(item, index);
      accumulator[key] = (accumulator[key] || 0) + 1;
      return accumulator;
    }, {});
  }

  function evaluateCondition(condition, context) {
    if (!condition || !Object.keys(condition).length) return true;
    if (Array.isArray(condition.all)) return condition.all.every((item) => evaluateCondition(item, context));
    if (Array.isArray(condition.any)) return condition.any.some((item) => evaluateCondition(item, context));
    if (condition.not) return !evaluateCondition(condition.not, context);

    const actual = resolvePath(context, condition.path);
    const operator = condition.op || "truthy";
    const expected = condition.value;

    switch (operator) {
      case "eq":
        return actual === expected;
      case "neq":
        return actual !== expected;
      case "in":
        return Array.isArray(expected) && expected.includes(actual);
      case "intersects":
        return intersects(
          Array.isArray(actual) ? actual : [actual],
          Array.isArray(expected) ? expected : [expected]
        );
      case "includes":
        return Array.isArray(actual) && actual.includes(expected);
      case "gt":
        return Number(actual) > Number(expected);
      case "gte":
        return Number(actual) >= Number(expected);
      case "lt":
        return Number(actual) < Number(expected);
      case "lte":
        return Number(actual) <= Number(expected);
      case "truthy":
        return Boolean(actual);
      case "falsy":
        return !actual;
      default:
        throw new Error(`Operatore condizione non supportato: ${operator}`);
    }
  }

  function matchesRule(ruleWhen, context) {
    return evaluateCondition(ruleWhen, context);
  }

  function firstMatchingRule(rules, context) {
    return (rules || []).find((rule) => matchesRule(rule.when, context)) || null;
  }

  function matchingRules(rules, context) {
    return (rules || []).filter((rule) => matchesRule(rule.when, context));
  }

  function selectTextId(rules, context) {
    const match = firstMatchingRule(rules, context);
    if (!match) throw new Error("Nessuna regola narrativa corrisponde al contesto richiesto.");
    return match.emit.text_id;
  }

  function matchingTextIds(rules, context) {
    return matchingRules(rules, context).map((rule) => rule.emit.text_id);
  }

  function buildRuntimeScope(model, answers, resolvedMetrics) {
    const metrics = resolvedMetrics || {};
    const activeBranchesSet = resolveBranches(model, answers);
    const questions = questionMap(model);
    const texts = textLibraryById(model);

    const scope = {
      model,
      form: formConfig(model),
      evaluation: evaluationConfig(model),
      reporting: reportingConfig(model),
      answers: answers || {},
      metrics,
      collections: collectionsConfig(model),
      activeBranches: Array.from(activeBranchesSet),
      question(id) {
        const item = questions.get(id);
        return item ? item.question : null;
      },
      questionsByIds(ids) {
        return dedupe(ids || [])
          .map((id) => questions.get(id))
          .filter(Boolean)
          .map((item) => item.question);
      },
      answersForQuestion(id, options) {
        return answerRows(model, answers, {
          ...(options || {}),
          questionIds: [id]
        });
      },
      answersForQuestions(ids, options) {
        return answerRows(model, answers, {
          ...(options || {}),
          questionIds: ids
        });
      },
      answerRows(options) {
        return answerRows(model, answers, options || {});
      },
      visibleQuestions(options) {
        return visibleQuestions(model, answers, {
          activeBranches: activeBranchesSet,
          includeInternal: Boolean(options?.includeInternal)
        }).map((item) => item.question);
      },
      customerQuestions() {
        return visibleQuestions(model, answers, {
          activeBranches: activeBranchesSet,
          includeInternal: false
        }).map((item) => item.question);
      },
      metric(metricId) {
        return metrics[metricId];
      },
      collection(name) {
        return collection(model, name);
      },
      bandFor(metricId, score) {
        return bandForMetric(model, metricId, score);
      },
      bandForMetric(metricId, score) {
        return bandForMetric(model, metricId, score);
      },
      matchingBand,
      hasBranch(tag) {
        return activeBranchesSet.has(tag);
      },
      isVisible(questionId) {
        const item = questions.get(questionId);
        return Boolean(item && isQuestionVisible(item.question, activeBranchesSet));
      },
      text(textId) {
        return texts.get(textId) || null;
      },
      sum,
      count,
      average,
      weightedAverage,
      min,
      max,
      unique,
      sortBy,
      round,
      clamp,
      coalesce,
      dedupe,
      intersects,
      countBy,
      resolvePath,
      evaluateCondition,
      matchesRule,
      firstMatchingRule,
      matchingRules,
      selectTextId,
      matchingTextIds
    };
    return scope;
  }

  function compileFormula(metricId, jsSource) {
    const cacheKey = `${metricId}::${jsSource}`;
    if (FORMULA_CACHE.has(cacheKey)) return FORMULA_CACHE.get(cacheKey);
    const compiled = new Function(
      "scope",
      `
        const {
          model,
          form,
          evaluation,
          reporting,
          answers,
          metrics,
          collections,
          activeBranches,
          question,
          questionsByIds,
          answersForQuestion,
          answersForQuestions,
          answerRows,
          visibleQuestions,
          customerQuestions,
          metric,
          collection,
          bandFor,
          bandForMetric,
          matchingBand,
          hasBranch,
          isVisible,
          text,
          sum,
          count,
          average,
          weightedAverage,
          min,
          max,
          unique,
          sortBy,
          round,
          clamp,
          coalesce,
          dedupe,
          intersects,
          countBy,
          resolvePath,
          evaluateCondition,
          matchesRule,
          firstMatchingRule,
          matchingRules,
          selectTextId,
          matchingTextIds
        } = scope;
        ${jsSource}
      `
    );
    FORMULA_CACHE.set(cacheKey, compiled);
    return compiled;
  }

  function evaluateMetric(model, metricId, answers, resolvedMetrics) {
    const metricConfig = metricsConfig(model)[metricId];
    if (!metricConfig) throw new Error(`Metrica non trovata: ${metricId}`);
    if (resolvedMetrics && Object.prototype.hasOwnProperty.call(resolvedMetrics, metricId)) {
      return resolvedMetrics[metricId];
    }
    const jsSource = metricConfig.formula?.js;
    if (!jsSource) throw new Error(`La metrica '${metricId}' non definisce formula.js`);
    const scope = buildRuntimeScope(model, answers, resolvedMetrics || {});
    const result = compileFormula(metricId, jsSource)(scope);
    if (resolvedMetrics) resolvedMetrics[metricId] = result;
    return result;
  }

  function evaluateAllMetrics(model, answers) {
    const metrics = metricsConfig(model);
    const resolved = {};
    const visiting = new Set();
    const visited = new Set();

    function visit(metricId) {
      if (visited.has(metricId)) return;
      if (visiting.has(metricId)) throw new Error(`Dipendenza ciclica rilevata nella metrica '${metricId}'`);
      visiting.add(metricId);
      const metricConfig = metrics[metricId];
      if (!metricConfig) throw new Error(`Metrica non trovata: ${metricId}`);
      (metricConfig.depends_on || []).forEach(visit);
      evaluateMetric(model, metricId, answers, resolved);
      visiting.delete(metricId);
      visited.add(metricId);
    }

    Object.keys(metrics).forEach(visit);
    return resolved;
  }

  function buildResultView(model, answers, metrics, viewId) {
    const views = reportingConfig(model).result_views || {};
    const view = views[viewId || "submit_result"] || null;
    if (!view) return null;
    return {
      id: viewId || "submit_result",
      title: view.title || null,
      blocks: view.blocks || [],
      metrics,
      answers
    };
  }

  return {
    formConfig,
    evaluationConfig,
    reportingConfig,
    metricsConfig,
    collectionsConfig,
    answerValues,
    collection,
    getQuestions,
    resolveBranches,
    isQuestionVisible,
    visibleQuestions,
    answerRows,
    requiredQuestionCoverage,
    buildRuntimeScope,
    evaluateMetric,
    evaluateAllMetrics,
    buildResultView,
    bandForMetric,
    matchingBand,
    textLibraryById,
    dedupe,
    resolvePath,
    evaluateCondition
  };
});
