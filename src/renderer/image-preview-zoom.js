'use strict';

// The preview keeps its original layout size while transforming only the image.
window.CortexImagePreviewZoom = Object.freeze({
  create(dialog, viewport, image) {
    const minScale = 0.25;
    const maxScale = 8;
    let scale = 1;
    let x = 0;
    let y = 0;
    let drag = null;

    function render() {
      image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    }

    function endDrag() {
      const pointerId = drag?.pointerId;
      drag = null;
      image.classList.remove('is-dragging');
      if (pointerId != null && image.hasPointerCapture(pointerId)) {
        image.releasePointerCapture(pointerId);
      }
    }

    function reset() {
      endDrag();
      scale = 1;
      x = 0;
      y = 0;
      image.style.transform = '';
    }

    viewport.addEventListener('wheel', (event) => {
      if (!dialog.open || !image.getAttribute('src')) return;
      event.preventDefault();
      const nextScale = Math.max(minScale, Math.min(maxScale, scale * Math.exp(-event.deltaY * 0.0015)));
      if (nextScale === scale) return;
      const rect = image.getBoundingClientRect();
      const ratio = nextScale / scale;
      x += (event.clientX - (rect.left + rect.width / 2)) * (1 - ratio);
      y += (event.clientY - (rect.top + rect.height / 2)) * (1 - ratio);
      scale = nextScale;
      render();
    }, { passive: false });

    image.addEventListener('pointerdown', (event) => {
      if (!dialog.open || event.button !== 0 || drag) return;
      event.preventDefault();
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x, y };
      image.classList.add('is-dragging');
      image.setPointerCapture(event.pointerId);
    });
    image.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      x = drag.x + event.clientX - drag.startX;
      y = drag.y + event.clientY - drag.startY;
      render();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      image.addEventListener(type, (event) => {
        if (drag?.pointerId === event.pointerId) endDrag();
      });
    }
    image.addEventListener('dragstart', (event) => event.preventDefault());
    viewport.addEventListener('dblclick', reset);

    return Object.freeze({ reset });
  }
});
