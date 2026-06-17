import { renderLlmsFullTxt } from "@/lib/seo/llms";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const body = await renderLlmsFullTxt();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
