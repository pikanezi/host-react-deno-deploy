import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import { extname } from "https://deno.land/std@0.224.0/path/extname.ts";
import { ByteSliceStream } from "https://deno.land/std@0.224.0/streams/byte_slice_stream.ts";
import { normalize } from "https://deno.land/std@0.224.0/path/posix/normalize.ts";
import { contentType } from "https://deno.land/std@0.224.0/media_types/mod.ts";

const target = ".";

async function indexResponse() {
  const file = await Deno.open(join(target, "index.html"));
  return new Response(file.readable, { status: 200 });
}

/**
 * parse range header.
 *
 * ```ts ignore
 * parseRangeHeader("bytes=0-100",   500); // => { start: 0, end: 100 }
 * parseRangeHeader("bytes=0-",      500); // => { start: 0, end: 499 }
 * parseRangeHeader("bytes=-100",    500); // => { start: 400, end: 499 }
 * parseRangeHeader("bytes=invalid", 500); // => null
 * ```
 *
 * Note: Currently, no support for multiple Ranges (e.g. `bytes=0-10, 20-30`)
 */
function parseRangeHeader(rangeValue: string, fileSize: number) {
  const rangeRegex = /bytes=(?<start>\d+)?-(?<end>\d+)?$/u;
  const parsed = rangeValue.match(rangeRegex);

  if (!parsed || !parsed.groups) {
    // failed to parse range header
    return null;
  }

  const { start, end } = parsed.groups;
  if (start !== undefined) {
    if (end !== undefined) {
      return { start: +start, end: +end };
    } else {
      return { start: +start, end: fileSize - 1 };
    }
  } else {
    if (end !== undefined) {
      // example: `bytes=-100` means the last 100 bytes.
      return { start: fileSize - +end, end: fileSize - 1 };
    } else {
      // failed to parse range header
      return null;
    }
  }
}

async function serveFile(
  req: Request,
  filePath: string,
  fileInfo: Deno.FileInfo
) {
  if (req.method !== "GET") {
    return new Response(`Method not allowed`, { status: 405 });
  }

  if (fileInfo.isDirectory) {
    await req.body?.cancel();
    return await indexResponse();
  }

  const headers = new Headers({
    server: "deno",
    "accept-ranges": "bytes",
  });

  // Set date header if access timestamp is available
  if (fileInfo.atime) {
    headers.set("date", fileInfo.atime.toUTCString());
  }

  // Set last modified header if last modification timestamp is available
  if (fileInfo.mtime) {
    headers.set("last-modified", fileInfo.mtime.toUTCString());
  }

  if (fileInfo.mtime) {
    // If a `if-none-match` header is present and the value matches the tag or
    // if a `if-modified-since` header is present and the value is bigger than
    // the access timestamp value, then return 304
    const ifNoneMatchValue = req.headers.get("if-none-match");
    const ifModifiedSinceValue = req.headers.get("if-modified-since");
    if (
      ifNoneMatchValue === null &&
      fileInfo.mtime &&
      ifModifiedSinceValue &&
      fileInfo.mtime.getTime() < new Date(ifModifiedSinceValue).getTime() + 1000
    ) {
      const status = 304;
      return new Response(null, {
        status,
        headers,
      });
    }
  }

  // Set mime-type using the file extension in filePath
  const contentTypeValue = contentType(extname(filePath));
  if (contentTypeValue) {
    headers.set("Content-Type", contentTypeValue);
  }

  const fileSize = fileInfo.size;

  const rangeValue = req.headers.get("Range");

  // handle range request
  // Note: Some clients add a Range header to all requests to limit the size of the response.
  // If the file is empty, ignore the range header and respond with a 200 rather than a 416.
  // https://github.com/golang/go/blob/0d347544cbca0f42b160424f6bc2458ebcc7b3fc/src/net/http/fs.go#L273-L276
  if (rangeValue && 0 < fileSize) {
    const parsed = parseRangeHeader(rangeValue, fileSize);

    // Returns 200 OK if parsing the range header fails
    if (!parsed) {
      // Set content length
      headers.set("Content-Length", `${fileSize}`);

      const file = await Deno.open(filePath);
      const status = 200;
      return new Response(file.readable, {
        status,
        headers,
      });
    }

    // Return 416 Range Not Satisfiable if invalid range header value
    if (
      parsed.end < 0 ||
      parsed.end < parsed.start ||
      fileSize <= parsed.start
    ) {
      // Set the "Content-range" header
      headers.set("Content-Range", `bytes */${fileSize}`);

      return new Response(null, {
        status: 416,
        headers,
      });
    }

    // clamps the range header value
    const start = Math.max(0, parsed.start);
    const end = Math.min(parsed.end, fileSize - 1);

    // Set the "Content-range" header
    headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);

    // Set content length
    const contentLength = end - start + 1;
    headers.set("Content-Length", `${contentLength}`);

    // Return 206 Partial Content
    const file = await Deno.open(filePath);
    await file.seek(start, Deno.SeekMode.Start);
    const sliced = file.readable.pipeThrough(
      new ByteSliceStream(0, contentLength - 1)
    );
    return new Response(sliced, {
      status: 206,
      headers,
    });
  }

  // Set content length
  headers.set(`Content-Length`, `${fileSize}`);

  const file = await Deno.open(filePath);
  const status = 200;
  return new Response(file.readable, {
    status,
    headers,
  });
}

function main() {
  return Deno.serve(async (req) => {
    if (req.method !== "GET") {
      return new Response(`Method not allowed`, { status: 405 });
    }
    const url = new URL(req.url);
    const decodedUrl = decodeURIComponent(url.pathname);
    let normalizedPath = normalize(decodedUrl);
    // Redirect paths like `/foo////bar` and `/foo/bar/////` to normalized paths.
    if (normalizedPath !== decodedUrl) {
      url.pathname = normalizedPath;
      return Response.redirect(url, 301);
    }
    // Remove trailing slashes to avoid ENOENT errors
    // when accessing a path to a file with a trailing slash.
    if (normalizedPath.endsWith("/")) {
      normalizedPath = normalizedPath.slice(0, -1);
    }
    const fsPath = join(target, normalizedPath);

    try {
      const fileInfo = await Deno.stat(fsPath);

      if (fileInfo.isDirectory && !url.pathname.endsWith("/")) {
        url.pathname += "/";
        return Response.redirect(url, 301);
      }
      if (fileInfo.isFile) {
        return serveFile(req, fsPath, fileInfo);
      }
    } catch (_) {
      //
    }
    return await indexResponse();
  });
}

if (import.meta.main) {
  main();
}
