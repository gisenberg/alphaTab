/** Lightweight score model and import surface without browser UI or synthesis. */
import '@coderline/alphatab/alphaTab.polyfills';

export { AlphaTabError, AlphaTabErrorType } from '@coderline/alphatab/AlphaTabError';
export { FormatError } from '@coderline/alphatab/FormatError';
export { Settings } from '@coderline/alphatab/Settings';
export { ImporterSettings } from '@coderline/alphatab/ImporterSettings';
export { ExporterSettings } from '@coderline/alphatab/ExporterSettings';
export * as importer from '@coderline/alphatab/importer/_barrel';
export * as exporter from '@coderline/alphatab/exporter/_barrel';
export * as io from '@coderline/alphatab/io/_barrel';
export * from '@coderline/alphatab/model/_barrel';
export * as model from '@coderline/alphatab/model/_barrel';
