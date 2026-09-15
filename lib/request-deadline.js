// The signal fences continuations after a timeout. Browser calls themselves
// are not cancellable, so callers must also clean up any late-created page.
export async function withRequestDeadline(operation, ms, label) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error(`${label} timed out after ${ms}ms`), {
        code: 'request_timeout', statusCode: 503,
      });
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
