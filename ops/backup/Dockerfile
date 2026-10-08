# The nightly backup job's image (DEPLOYMENT.md §6): the PostgreSQL 18
# client tools — the server's major version, as pg_dump requires — plus age,
# the AWS CLI, curl and openssl. Nothing of the application is in it: no
# application code, no application credentials.
FROM postgres:18-alpine

RUN apk add --no-cache bash age aws-cli curl openssl coreutils \
 && adduser -D -H -u 10001 backup

COPY --chmod=0555 backup.sh /usr/local/bin/lbts-backup

USER backup
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/lbts-backup"]
