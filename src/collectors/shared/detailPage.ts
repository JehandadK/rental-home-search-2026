/**
 * Reads a loaded detail page in the headed browser tab. Waits for the store
 * block (or a settled page without it), then returns the public document with
 * scripts, styles and frames removed. Nothing here clicks, reloads or answers
 * anything on the page: a verification page is returned as it is.
 */
export function readDetailPageExpression(requestedUrl: string, storeBlockSelector: string, timeoutMs = 20_000): string {
  return `(async () => {
    const start = Date.now();
    const wanted = new URL(${JSON.stringify(requestedUrl)}).pathname.replace(/\\/+$/, '');
    // A tab may still show the previous ad until the new document commits: never read that one.
    const current = () => location.pathname.replace(/\\/+$/, '') === wanted;
    while (!(current() && document.querySelector(${JSON.stringify(storeBlockSelector)}))) {
      const settled = current() && document.readyState !== 'loading' && Date.now() - start > 10000;
      if (settled || Date.now() - start > ${timeoutMs}) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const root = document.documentElement.cloneNode(true);
    root.querySelectorAll('script,style,noscript,iframe,svg,template').forEach((element) => element.remove());
    return JSON.stringify({ url: location.href, title: document.title, html: root.outerHTML });
  })()`;
}

export interface EvaluateResult {
  result?: { result?: { value?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
}

/** The page read by `readDetailPageExpression`, or the in-page error. */
export function detailPageFrom(response: EvaluateResult, status?: number): { status?: number; url: string; title: string; html: string } {
  const exception = response.result?.exceptionDetails;
  if (exception) throw new Error(`Detail page could not be read: ${(exception.exception?.description ?? exception.text ?? "evaluation failed").split("\n")[0].slice(0, 300)}`);
  const value = response.result?.result?.value;
  if (!value) throw new Error("Detail page could not be read");
  const page = JSON.parse(value) as { url: string; title: string; html: string };
  return { ...(status !== undefined ? { status } : {}), url: page.url, title: page.title ?? "", html: page.html };
}
