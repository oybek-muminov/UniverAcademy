import sharp from 'sharp';
import { prepareImage, maxSide, rejectImage } from './image-policy.mjs';
export {imageLimits} from './image-policy.mjs';

export async function privatePng(bytes, contentType) {
  const {input} = prepareImage(bytes,contentType);
  try {
    const image = sharp(input,{ limitInputPixels:maxSide * maxSide,failOn:'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== (contentType === 'image/png' ? 'png' : 'svg') ||
        !metadata.width || !metadata.height || Math.max(metadata.width,metadata.height) > maxSide || (metadata.pages ?? 1) > 1) {
      rejectImage('Statik rasmning eng katta tomoni 2048 piksel bo‘lishi kerak.');
    }
    const png = await image.timeout({ seconds:4 }).png().toBuffer();
    return png;
  } catch (error) {
    if (error.code === 'INVALID_IMAGE') throw error;
    rejectImage('Rasm o‘qilmadi. PNG yoki statik SVG chizmasini tekshiring.');
  }
}
