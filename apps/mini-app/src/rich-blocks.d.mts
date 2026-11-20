import type { QuestionBlock } from './staging-student-port.ts';
export function renderBlocks(container: HTMLElement, blocks: QuestionBlock[], options: {
  loadAsset?(block: Extract<QuestionBlock,{type:'image'}>,signal:AbortSignal):Promise<Blob>;
  loadKatex?:()=>Promise<unknown>;
  signal?:AbortSignal;
}):HTMLElement;
