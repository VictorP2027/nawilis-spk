import { collections } from '@spk/core';
import { db } from '../../../../../lib/db';

export const runtime = 'nodejs';

/**
 * GET /api/spk/:id/signature?who=menyerahkan|menerima — one captured signature
 * as an image.
 *
 * It exists so the admin table can show signature thumbnails WITHOUT the list
 * endpoint carrying them. Inlined as data: URLs they were 96% of /api/spk —
 * 1.5 MB, re-sent every 10 seconds by the admin poll, which is what exhausted
 * the hosting bandwidth. Served from here each one is fetched once and then
 * cached by the browser forever: a signature is captured at intake and never
 * edited, so `immutable` is the truth and not an optimisation.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  await db();
  const { id } = await ctx.params;
  const who = new URL(req.url).searchParams.get('who') === 'menerima' ? 'menerima' : 'menyerahkan';

  const doc = await collections
    .spk()
    .findOne({ _id: id }, { projection: { [`signatures.${who}.imageDataUrl`]: 1 } });

  const url = (doc?.signatures as Record<string, { imageDataUrl?: string | null }> | undefined)?.[who]?.imageDataUrl;
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(url ?? '');
  if (!m) return new Response(null, { status: 404 });

  return new Response(Buffer.from(m[2]!, 'base64'), {
    headers: {
      'content-type': m[1]!,
      // The signature cannot change, so never ask again.
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
}
