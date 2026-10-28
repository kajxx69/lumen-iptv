// Pipeline de fusion multi-sources : normalisation, empreinte, fusion.
export { displayName, normalizeName, stripAccents } from './normalize.js';
export {
  GRID_MATCH,
  type GridComparison,
  type GridMatchOptions,
  type GridProgramme,
  type GridVerdict,
  compareGrids,
  fingerprintName,
} from './fingerprint.js';
export {
  type ChannelGroup,
  MERGE_SOLO,
  type MergeEntry,
  type MergeOptions,
  mergeChannels,
  pairKey,
  refKey,
} from './merge.js';
