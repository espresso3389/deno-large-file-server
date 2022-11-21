# deno-large-file-server

## Key Features

- API server running on [Deno](https://deno.land/)
- Large file upload using [File.slice](https://developer.mozilla.org/ja/docs/Web/API/Blob/slice)
- SHA-256 hashing concurrently with uploading
- Large file streaming using HTTP range requests

## Prerequisites

The server can run on Linux, Windows, and possibly on macOS.

All you have to install are:

- [Deno](https://deno.land/)
- [file](https://man7.org/linux/man-pages/man1/file.1.html) command

## Run Server

The following command runs the server on http://localhost:3000:

```bash
deno run -A src/index.ts
```

## Debugging

For debugging purpose, use VS Code.

## Test

### Creating New File Entry

```shell
curl -H "Content-Type: application/json" -d '{"name": "hello.txt", "contentType": "text/plain"}' http://localhost:3000/api/v1/files/
```

```json
{
  "id": "15df4254-8d13-4c33-b198-f8efa9851c86",
  "name": "hello.txt",
  "contentType": "text/plain",
  "size": 0,
  "lastUpdate": "2022-11-21T02:58:22.550Z",
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "uri": "http://localhost:3000/api/v1/files/15df4254-8d13-4c33-b198-f8efa9851c86"
}
```

### Upload The First Part

Append the first part `Hello` to the created entry:

```shell
curl -H "Content-Type: application/octet-stream" -d "Hello" http://localhost:3000/api/v1/files/15df4254-8d13-4c33-b198-f8efa9851c86/upload
```

```json
{
  "id": "15df4254-8d13-4c33-b198-f8efa9851c86",
  "name": "hello.txt",
  "contentType": "text/plain",
  "size": 5,
  "lastUpdate": "2022-11-21T02:58:45.458Z",
  "sha256": "185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969",
  "uri": "http://localhost:3000/api/v1/files/15df4254-8d13-4c33-b198-f8efa9851c86"
}
```

### Upload The Second Part

Append the next part `, world` to the entry with the byte offset 5 (`offset=5` on the query):

```shell
curl -H "Content-Type: application/octet-stream" -d ", world" http://localhost:3000/api/v1/files/15df4254-8d13-4c33-b198-f8efa9851c86/upload?offset=5
```

```json
{
  "id": "15df4254-8d13-4c33-b198-f8efa9851c86",
  "name": "hello.txt",
  "contentType": "text/plain",
  "size": 12,
  "lastUpdate": "2022-11-21T02:59:18.688Z",
  "sha256": "4017047d57314493f967a5eb86543c4af571c814ede8501c275ebd5258f6a626",
  "uri": "http://localhost:3000/api/v1/files/15df4254-8d13-4c33-b198-f8efa9851c86"
}
```

### Upload The Last Part

Append `!` (at `offset=12`) to the entry and finalize (make read-only) the file using `finalize=1`:

```shell
curl -H "Content-Type: application/octet-stream" -d "!" "http://localhost:3000/api/v1/files/15df4254-8d13-4c33-b198-f8efa9851c86/upload?offset=12&finalize=1"
```

```json
{
  "id": "15df4254-8d13-4c33-b198-f8efa9851c86",
  "name": "hello.txt",
  "contentType": "text/plain",
  "size": 13,
  "lastUpdate": "2022-11-21T03:02:16.254Z",
  "sha256": "9bf7a31085ff24263309dac71f761fb17e84316473a7f43f7186542b8c7f6e89",
  "uri": "http://localhost:3000/api/v1/files/15df4254-8d13-4c33-b198-f8efa9851c86"
}
```

After the finalization, the entry never accept further `/upload` requests.

### Download The Content

You can download the content using the URL http://localhost:3000/api/v1/files/15df4254-8d13-4c33-b198-f8efa9851c86.

To let the browser to save the file with the name `test.txt`, you can append the name to the end of URL,the server anyway ignore the last part on processing the file:

```shell
curl http://localhost:3000/api/v1/files/15df4254-8d13-4c33-b198-f8efa9851c86/test.txt
```

```text
Hello, world!
```

### Get The Content Information

You can, of course, get the file information using the following URL:

```shell
curl http://localhost:3000/api/v1/files/15df4254-8d13-4c33-b198-f8efa9851c86/json
```

```json
{
  "id": "15df4254-8d13-4c33-b198-f8efa9851c86",
  "name": "hello.txt",
  "contentType": "text/plain",
  "size": 13,
  "lastUpdate": "2022-11-21T03:02:16.254Z",
  "sha256": "9bf7a31085ff24263309dac71f761fb17e84316473a7f43f7186542b8c7f6e89",
  "uri": "http://localhost:3000/api/v1/files/15df4254-8d13-4c33-b198-f8efa9851c86"
}
```
