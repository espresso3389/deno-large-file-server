import { Buffer } from "buffer";
import { serveFile } from "file_server";
import { bufferToHex } from "hextools";
import { serve } from "server";
import os from "os";
import { dirname } from "path";
import { Sha256, Sha256State } from "./sha256.ts";

/** It's important to have a restriction on request size to reduce server load. */
const rangeRequestMaxBytes = 1024 * 1024;

const port = Number(Deno.env.get("APPSERVER_PORT") || 3000);
const baseUri = Deno.env.get("APPSERVER_BASEURI") || `http://localhost:${port}`;

interface FileInfo {
  /**
   * UUID for the file.
   */
  id: string;
  /**
   * File name for the displaying purpose (not used for internal storage).
   */
  name: string;
  /**
   * Content-Type for the file.
   */
  contentType: string;
  /**
   * File size.
   */
  size: number;
  /**
   * Last update timestamp.
   */
  lastUpdate: string;
  /**
   * Current SHA-256 hash.
   * It is also valid during the uploading process; the hash of the uploaded file content so far.
   */
  sha256: string;
}

/**
 * Info. related ongoing file uploads.
 */
interface FileUploadingInfo {
  /**
   * Final SHA-256 internal state to restart hashing process.
   */
  sha256context?: Sha256State | undefined;
  /**
   * Whether the file is finalized or not (still being uploaded)
   */
  finalized: boolean;
}

type File = FileInfo & FileUploadingInfo;

const getFileInfoWithUri = (file: File): FileInfo & { uri: string } => ({
  id: file.id,
  name: file.name,
  contentType: file.contentType,
  size: file.size,
  lastUpdate: file.lastUpdate,
  sha256: file.sha256,
  uri: `${baseUri}/api/v1/files/${file.id}`,
});

/** App executable file path with trailing slash. */
const appDirPath = new URL(".", import.meta.url).pathname.substring(os.platform() == "windows" ? 1 : 0);

/** Data directory */
const appDataPath = `${appDirPath}../data/`;

const getFilePathFromId = (id: string): string => `${appDataPath}${id.substring(0, 3)}/${id}`;

const getFile = async (filePath: string): Promise<File | undefined> => {
  try {
    return JSON.parse(await Deno.readTextFile(filePath)) as File;
  } catch (e) {
    return undefined;
  }
};

const getFileFromId = (id: string): Promise<File | undefined> => getFile(getFilePathFromId(id) + ".json");

const saveFile = async (file: File): Promise<void> => {
  const filePath = getFilePathFromId(file.id);
  await Deno.mkdir(dirname(filePath), { recursive: true });
  await Deno.writeTextFile(filePath + ".json", JSON.stringify(file));
};

type ParameterPayload = { [key: string]: string };

const returnStatus = (status: number, body?: string | undefined) => new Response(body, { status });

const parseQuery = (result: URLPatternResult) => Object.fromEntries(new URLSearchParams(result.search.input));

type RequestMethod = "GET" | "POST";

const handlers: {
  method: RequestMethod;
  path: URLPattern;
  handler: (req: Request, result: URLPatternResult) => Promise<Response> | Response;
}[] = [];

//
// POST /files/<fileId>/upload
//
handlers.push({
  method: "POST",
  path: new URLPattern({ pathname: "/api/v1/files/:fileId/upload" }),
  handler: async (req, result) => {
    const { fileId } = result.pathname.groups;
    const file = await getFileFromId(fileId);
    if (file == null) {
      return returnStatus(404);
    }
    if (file.finalized) {
      // the file is already finalized; no more update allowed
      return returnStatus(401);
    }
    const queries = parseQuery(result);
    const offset = parseInt(queries.offset ?? "0");
    if (offset !== file.size) {
      return returnStatus(400);
    }
    const finalize = queries.finalize !== undefined;

    const sha256 = Sha256.restoreState(file.sha256context);

    const body = req.body?.getReader();
    if (body == null) {
      return returnStatus(400);
    }

    const filePath = getFilePathFromId(file.id);
    await Deno.mkdir(dirname(filePath), { recursive: true });
    const fs = await Deno.open(filePath, { read: true, write: true, create: true });
    await fs.truncate(file.size);
    await fs.seek(file.size, Deno.SeekMode.Start);

    try {
      for (;;) {
        const { done, value } = await body.read();
        if (done) break;
        sha256.update(value, value.length);
        await fs.write(value);
        file.size += value.length;
      }
      file.finalized = finalize;
      if (file.finalized) {
        file.sha256context = undefined;
        const contentTypeGuessed = await guessContentType(file);
        if (contentTypeGuessed != null) {
          file.contentType = contentTypeGuessed;
        }
      } else {
        file.sha256context = sha256.saveState();
      }
      file.lastUpdate = new Date().toISOString();
      file.sha256 = bufferToHex(sha256.digest());
      await saveFile(file);
      return Response.json(getFileInfoWithUri(file));
    } finally {
      fs.close();
    }
  },
});

const guessContentType = async (file: File): Promise<string | undefined> => {
  const p = Deno.run({
    cmd: [
      "file",
      "-b",
      "--mime-type",
      getFilePathFromId(file.id),
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code } = await p.status();
  if (code === 0) {
    return new TextDecoder().decode(await p.output()).trim();
  } else {
    const message = new TextDecoder().decode(await p.stderrOutput());
    console.log(`file command failed: code=${code}: ${message}`);
    return undefined;
  }
};

//
// GET /files/<fileId>/info
//
handlers.push({
  method: "GET",
  path: new URLPattern({ pathname: "/api/v1/files/:fileId/json" }),
  handler: async (req, result) => {
    const { fileId } = result.pathname.groups;
    const file = await getFileFromId(fileId);
    if (file == null) {
      return returnStatus(404);
    }
    return Response.json(getFileInfoWithUri(file));
  },
});
//
// GET /files/<fileId>[/ANY_YOUR_FAVORITE_FILENAME.EXT]
//
// append /ANY_YOUR_FAVORITE_FILENAME.EXT to download the file with that name.
handlers.push(
  {
    method: "GET",
    path: new URLPattern({ pathname: "/api/v1/files/:fileId{/*}?" }),
    handler: async (req, result) => {
      const { fileId } = result.pathname.groups;
      const file = await getFileFromId(fileId);
      if (file == null) {
        return returnStatus(404);
      }
      const rangesStr = req.headers.get("Range");
      if (rangesStr == null) {
        return new Response((await Deno.open(getFilePathFromId(file.id))).readable, {
          headers: {
            "content-type": file.contentType,
            "content-length": file.size.toString(),
            "content-disposition": "inline",
            "etag": file.sha256,
          },
        });
      } else if (typeof rangesStr !== "string" || !rangesStr.startsWith("bytes=")) {
        return returnStatus(400);
      } else {
        const ranges: { start: number; end: number }[] = [];
        for (const range of rangesStr.substring(6).split(/,\s*/).map((s) => s.trim().split("-"))) {
          ranges.push({
            start: range[0] === "" ? 0 : parseInt(range[0]),
            end: range[1] === "" ? file.size : parseInt(range[1]) + 1,
          });
        }
        if (ranges.length === 0) {
          ranges.push({ start: 0, end: 0 });
        } else if (ranges.length > 1) {
          return returnStatus(416); // maybe not correct return value
        }

        let { start, end } = ranges[0];
        if (end - start > rangeRequestMaxBytes) {
          end = start + rangeRequestMaxBytes;
        }
        const fs = (await Deno.open(getFilePathFromId(file.id)));
        await fs.seek(start, Deno.SeekMode.Start);
        return new Response(fs.readable, {
          status: 206,
          headers: {
            "content-type": file.contentType,
            "content-length": (end - start).toString(),
            "content-range": `bytes ${start}-${end - 1}/${file.size}`,
            "etag": file.sha256,
          },
        });
      }
    },
  },
);

//
// GET /files
//
handlers.push(
  {
    method: "GET",
    path: new URLPattern({ pathname: "/api/v1/files{/}?" }),
    handler: async (req, result) => {
      const json = [];
      try {
        for await (const dir of Deno.readDir(appDataPath)) {
          if (!dir.isDirectory) continue;
          const dn = `${appDataPath}${dir.name}`;
          try {
            for await (const f of Deno.readDir(dn)) {
              const fn = `${dn}/${f.name}`;
              try {
                if (!f.isFile || !f.name.endsWith(".json")) continue;
                const file = await getFile(fn);
                if (file != null) {
                  json.push(getFileInfoWithUri(file));
                }
              } catch (e) {
                console.log(`${fn}: ${e}`);
              }
            }
          } catch (e) {
            console.log(`${dn}: ${e}`);
          }
        }
      } catch (e) {
        console.log(`/api/v1/files: ${e}`);
      }

      return Response.json(json);
    },
  },
);
//
// POST /files/
//
handlers.push(
  {
    method: "POST",
    path: new URLPattern({ pathname: "/api/v1/files{/}?" }),
    handler: async (req, result) => {
      const json = JSON.parse(await req.text());
      const name = json["name"] as string;
      const contentType = json["contentType"] as string ?? "application/octet-stream";
      if (name == null) {
        return returnStatus(400);
      }
      const id = crypto.randomUUID();
      const newFile: File = {
        id,
        name,
        contentType,
        size: 0,
        lastUpdate: new Date().toISOString(),
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // SHA-256 for empty file
        finalized: false,
      };
      await saveFile(newFile);
      return Response.json(getFileInfoWithUri(newFile));
    },
  },
);

//
// GET /
//
handlers.push(
  {
    method: "GET",
    path: new URLPattern({ pathname: "/*" }),
    handler: (req, result) => {
      const fileName = result.pathname.groups[0];
      return serveFile(req, `${appDirPath}static/${fileName === "" ? "index.html" : fileName}`);
    },
  },
);

const handleRequest = (req: Request): Promise<Response> | Response => {
  for (const h of handlers) {
    if (h.method === req.method) {
      const m = h.path.exec(req.url);
      if (m != null) {
        return h.handler(req, m);
      }
    }
  }
  return returnStatus(404);
};

await serve(async (req) => {
  try {
    return await handleRequest(req);
  } catch (e) {
    console.log(e);
    // try to complete processing the request
    return returnStatus(500, e?.toString());
  }
}, { port });
