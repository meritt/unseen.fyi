import svgSource from './unseen.svg' with { type: 'text' };

export const UNSEEN_SVG_SOURCE = svgSource;

export const extractInnerContent = (source: string): string =>
  source.replace(/^[\s\S]*?<svg[^>]*>/u, '').replace(/<\/svg>\s*$/u, '');
