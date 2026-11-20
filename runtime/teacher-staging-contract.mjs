// Compile the same pinned server validators as the offline parity suite, without test actors or sessions.
import {readFileSync} from 'node:fs';
import compiler from '../packages/contract-validation/ajv-config.cjs';
import view from '../packages/contract-validation/view-builder.cjs';
const specification=readFileSync(new URL('../contracts/telegram-return.openapi.json',import.meta.url));
const {validators}=compiler.compileView(view.buildView(specification).view);
export function validate(name,value){return validators.get(name)?.(value)===true;}
