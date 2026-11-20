import katex from 'katex';
import {formulaRenderOptions} from '../../apps/mini-app/src/rich-blocks.mjs';

// The production writer can call this same guard with its canonical QuestionWrite blocks.
function check(blocks, location) {
  for (const [index,block] of (blocks ?? []).entries()) {
    if (block.type !== 'formula') continue;
    try {
      if (typeof block.latex !== 'string' || !block.latex.trim() || block.latex.length > 10000) throw Error();
      katex.renderToString(block.latex, formulaRenderOptions(block.display));
    } catch (error) {
      const column = Number.isInteger(error.position) ? ', ' + (error.position + 1) + '-belgi' : '';
      const detail = location + ', ' + (index + 1) + '-blok' + column + '. Formula o‘qilmadi. LaTeX kodi va buyruqni tekshiring.';
      throw Object.assign(new Error(detail),{ status:422,code:'INVALID_FORMULA',detail });
    }
  }
}
export function validatePilotFormulas(questions, instructions = []) {
  check(instructions,'Test yo‘riqnomasi');
  questions.forEach((question,i) => {
    const name = (i + 1) + '-savol';
    check(question.prompt_blocks,name);
    question.options?.forEach((option,j) => check(option.blocks,name + ', ' + (j + 1) + '-javob'));
    check(question.explanation_blocks,name + ', yechim');
  });
}
