/** Low-level notation renderer surface without AlphaTabApi or alphaSynth. */
import '@coderline/alphatab/alphaTab.polyfills';

export { CoreSettings } from '@coderline/alphatab/CoreSettings';
export { DisplaySettings, SystemsLayoutMode } from '@coderline/alphatab/DisplaySettings';
export { LayoutMode } from '@coderline/alphatab/LayoutMode';
export { NotationMode, NotationSettings, TabRhythmMode } from '@coderline/alphatab/NotationSettings';
export { RenderingResources } from '@coderline/alphatab/RenderingResources';
export { Settings } from '@coderline/alphatab/Settings';
export { ScoreRenderer } from '@coderline/alphatab/rendering/ScoreRenderer';
export * as rendering from '@coderline/alphatab/rendering/_barrel';
export { CssFontSvgCanvas } from '@coderline/alphatab/platform/svg/CssFontSvgCanvas';
export { FontSizeDefinition, FontSizes } from '@coderline/alphatab/platform/svg/FontSizes';
export { SvgCanvas } from '@coderline/alphatab/platform/svg/SvgCanvas';
