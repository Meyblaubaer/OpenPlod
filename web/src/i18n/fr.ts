import { workspace } from './fr/workspace'
import { studio } from './fr/studio'
import { documents } from './fr/documents'
import { devices } from './fr/devices'

/** French UI strings, keyed by the English source string. Each area keeps its own file. */
export const fr: Record<string, string> = { ...workspace, ...studio, ...documents, ...devices }
