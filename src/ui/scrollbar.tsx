import React from 'react';
import { Box, Text, type DOMElement } from 'ink';

export function scrollbarMetrics(total: number, viewport: number, offset: number): { size: number; top: number; travel: number; maximum: number } {
  const height = Math.max(1, viewport), maximum = Math.max(0, total - height);
  const size = maximum ? Math.max(1, Math.floor(height * height / total)) : height;
  const travel = height - size;
  return { size, top: maximum ? Math.round(Math.max(0, Math.min(maximum, offset)) / maximum * travel) : 0, travel, maximum };
}
export function Scrollbar({ total, viewport, offset, trackRef, color, muted }: { total: number; viewport: number; offset: number; trackRef: React.RefObject<DOMElement | null>; color: string; muted: string }): React.JSX.Element {
  const metrics = scrollbarMetrics(total, viewport, offset);
  return <Box ref={trackRef} width={1} height={viewport} flexShrink={0} flexDirection="column">{Array.from({ length: viewport }, (_, i) => <Text key={i} color={i >= metrics.top && i < metrics.top + metrics.size ? color : muted}>{metrics.maximum ? i >= metrics.top && i < metrics.top + metrics.size ? '┃' : '│' : ' '}</Text>)}</Box>;
}
