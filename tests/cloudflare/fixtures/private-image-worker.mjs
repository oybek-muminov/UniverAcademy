import {privatePng} from '../../../packages/test-content/worker-private-image.mjs';
export default {async fetch(request) {
  try {
    const output=await privatePng(new Uint8Array(await request.arrayBuffer()),request.headers.get('content-type'));
    return new Response(output,{headers:{'content-type':'image/png'}});
  } catch (error) {return Response.json({code:error.code??'UNEXPECTED'},{status:error.status??500});}
}};
