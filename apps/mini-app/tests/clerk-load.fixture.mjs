// Test-only DEV harness for the actual production mount (main DEV selects demo).
import { mountCommonProductionEntry } from '../src/common-production-entry.tsx';
mountCommonProductionEntry(document.getElementById('root'), { env: import.meta.env, pageOrigin: location.origin, scope: window });
