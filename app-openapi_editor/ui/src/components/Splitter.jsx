import React, { useCallback, useRef } from 'react';

// A thin draggable divider between two panes. `orientation="vertical"`
// means the divider itself is a vertical bar (dragged left/right, resizing
// side-by-side panes); `"horizontal"` means a horizontal bar (dragged up/
// down). Calls onResize(deltaPx) on every mouse-move while dragging - the
// caller owns the actual size state and any clamping/persistence, this
// component only reports raw pointer movement.
export default function Splitter({ onResize, orientation = 'vertical' }) {
  const draggingRef = useRef(false);

  const handleMouseDown = useCallback((event) => {
    event.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (moveEvent) => {
      if (!draggingRef.current) return;
      onResize(orientation === 'vertical' ? moveEvent.movementX : moveEvent.movementY);
    };
    const handleMouseUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [onResize, orientation]);

  return (
    <div
      className={`splitter splitter-${orientation}`}
      onMouseDown={handleMouseDown}
      role="separator"
      aria-orientation={orientation}
    />
  );
}
