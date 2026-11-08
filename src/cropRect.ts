// claude2's dragRect: the rectangle from a drag's start to the pointer, in the picture's own
// pixels, both ends clamped onto it. object-fit letterboxes the picture inside the img element, so
// `box` alone does not say where it sits; left, top and scale say that, for drawing the rectangle.
interface Point { x: number; y: number }
interface Box { left: number; top: number; width: number; height: number }

export function cropRect(box: Box, natural: { width: number; height: number }, from: Point, to: Point): { x: number; y: number; w: number; h: number; left: number; top: number; scale: number } {
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  const left = box.left + (box.width - width) / 2;
  const top = box.top + (box.height - height) / 2;
  const onX = (x: number): number => (Math.min(left + width, Math.max(left, x)) - left) / scale;
  const onY = (y: number): number => (Math.min(top + height, Math.max(top, y)) - top) / scale;
  const [x1, y1, x2, y2] = [onX(from.x), onY(from.y), onX(to.x), onY(to.y)];
  return { x: Math.round(Math.min(x1, x2)), y: Math.round(Math.min(y1, y2)), w: Math.round(Math.abs(x2 - x1)), h: Math.round(Math.abs(y2 - y1)), left, top, scale };
}
