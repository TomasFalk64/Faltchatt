import proj4Import from 'proj4';
import definitionsImport from 'proj4js-definitions';

const proj4 = normalizeProj4(proj4Import);
const definitions = normalizeDefinitions(definitionsImport);

if (!proj4.__faltchattDefinitionsLoaded) {
  proj4.defs(definitions);
  Object.defineProperty(proj4, '__faltchattDefinitionsLoaded', {
    value: true,
    enumerable: false,
  });
}

function normalizeProj4(value) {
  if (typeof value === 'function' && typeof value.defs === 'function') return value;
  if (typeof value?.defs === 'function') return value;
  if (typeof value?.default === 'function' && typeof value.default.defs === 'function') return value.default;
  if (typeof value?.default?.defs === 'function') return value.default;
  throw new Error('proj4 kunde inte initieras.');
}

function normalizeDefinitions(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.default)) return value.default;
  return value?.default || value;
}

export default proj4;
