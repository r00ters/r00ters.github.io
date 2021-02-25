; (function () {

	'use strict';

	var isMobile = {
		Android: function () {
			return navigator.userAgent.match(/Android/i);
		},
		BlackBerry: function () {
			return navigator.userAgent.match(/BlackBerry/i);
		},
		iOS: function () {
			return navigator.userAgent.match(/iPhone|iPad|iPod/i);
		},
		Opera: function () {
			return navigator.userAgent.match(/Opera Mini/i);
		},
		Windows: function () {
			return navigator.userAgent.match(/IEMobile/i);
		},
		any: function () {
			return (isMobile.Android() || isMobile.BlackBerry() || isMobile.iOS() || isMobile.Opera() || isMobile.Windows());
		}
	};



	// iPad and iPod detection	
	var isiPad = function () {
		return (navigator.platform.indexOf("iPad") != -1);
	};

	var isiPhone = function () {
		return (
			(navigator.platform.indexOf("iPhone") != -1) ||
			(navigator.platform.indexOf("iPod") != -1)
		);
	};

	var fullHeight = function () {

		if (!isMobile.any()) {
			$('.js-fullheight').css('height', $(window).height());
			$(window).resize(function () {
				$('.js-fullheight').css('height', $(window).height());
			});
		}

	};

	// Parallax
	var parallax = function () {
		if (!isMobile.any()) {
			$(window).stellar();
		}
	};

	// Animations
	// Home
	var homeAnimate = function () {
		if ($('#fh5co-home').length > 0) {

			$('#fh5co-home').waypoint(function (direction) {

				if (direction === 'down' && !$(this.element).hasClass('animated')) {


					setTimeout(function () {
						$('#fh5co-home .to-animate').each(function (k) {
							var el = $(this);

							setTimeout(function () {
								el.addClass('fadeInUp animated');
							}, k * 200, 'easeInOutExpo');

						});
					}, 200);


					$(this.element).addClass('animated');

				}
			}, { offset: '80%' });

		}
	};

	// Document on load.
	$(function () {
		parallax();
		fullHeight();

		// Animations
		homeAnimate();
	});


}());