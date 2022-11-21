FROM denoland/deno:alpine

RUN apk add --update --no-cache ca-certificates git file 
RUN mkdir -p /server
COPY . /server/

WORKDIR /server
ENTRYPOINT []
CMD ["deno", "run", "-A", "src/index.ts"]
