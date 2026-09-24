/**
 * `@jean/coreutils` — in-process shell utilities (architecture §8.2).
 *
 * Zero fork/exec overhead, and — more usefully — identical behaviour on
 * Windows, where `sed`, `awk`, `jq`, and `bc` are either absent or subtly
 * different from the GNU versions every shell snippet is written against.
 *
 * Each utility is a pure function over strings, so they compose into a pipeline
 * without a shell in between.
 */

export {
  awk,
  column,
  comm,
  cut,
  expand,
  fail,
  fmt,
  fold,
  fromLines,
  head,
  join,
  nl,
  ok,
  paste,
  rev,
  sed,
  seq,
  shuf,
  sort,
  tail,
  toLines,
  tr,
  unexpand,
  uniq,
  wc,
  yes,
  type CutOptions,
  type SortOptions,
  type TrOptions,
  type UniqOptions,
  type UtilResult,
  type WcCounts,
} from './text.ts'

export {
  baseName,
  bc,
  date,
  diff,
  dirName,
  env,
  extName,
  jq,
  realPath,
  tee,
  xargs,
} from './data.ts'

export {
  createTextTool,
  NATIVE_ONLY_OPS,
  PIPELINE_OPS,
  runPipeline,
  runPipelineNative,
  toBuiltin,
  type Stage,
} from './tool.ts'
