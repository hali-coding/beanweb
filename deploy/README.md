# Deploying BeanWeb

Both targets run on **sysweb1**, a host shared with other sites:

| Target | Host | Web server | Deploy user | Backend port |
|---|---|---|---|---|
| test — `beanweb-test.halicode.com` | sysweb1 | nginx | `ci` | `127.0.0.1:8081` |
| prod — `beanweb.halicode.com` | sysweb1 | nginx | `ci` | `127.0.0.1:8080` |

Each GitHub environment (`test`, `production`) has its own deploy key.

Both domains sit behind Cloudflare's proxy. The origin IP lives in two places
only: the Cloudflare DNS record and the GitHub environment secret `SERVER_IP`.

CI does the deploys (`.github/workflows/deploy-*.yml`). What CI does **not** do
is touch `/etc`: the nginx config, the certificate and sudoers are installed by
hand, once, from this directory.

## Names BeanWeb claims on sysweb1

Check these for collisions before installing — the host is shared.

| Kind | Name |
|---|---|
| Static roots | `/var/www/beanweb-test`, `/var/www/beanweb` |
| Coffee Shop source | `/var/www/beanweb-coffeeshop-test`, `/var/www/beanweb-coffeeshop` |
| Package catalogue | `/var/www/beanweb-pkgs` (read-only mount, shared by test and prod) |
| Ports | `127.0.0.1:8081` test, `127.0.0.1:8080` prod |
| Compose project | `beanweb-coffeeshop-test`, `beanweb-coffeeshop` |
| nginx | `sites-available/beanweb.halicode.com` and `beanweb-test.halicode.com`, logs `beanweb.*` and `beanweb-test.*` (`vhost` format) |
| Certificate | `--cert-name beanweb-test` and `beanweb`, challenge webroot `/var/www/letsencrypt` |

## One-time setup for test on sysweb1

```bash
# paths, owned by the deploy user
sudo mkdir -p /var/www/{beanweb-test,beanweb-coffeeshop-test,beanweb-pkgs}
sudo chown ci /var/www/{beanweb-test,beanweb-coffeeshop-test,beanweb-pkgs}   # ci's primary group is sudo
```

On sysweb1 `ci` already has passwordless sudo for everything and is in the
`docker` group, so no sudoers entry is needed. That also means the `test`
environment's `SERVER_KEY` is a root key for the whole host -- fine while every
site on it is yours; if that changes, move BeanWeb to its own user with a
sudoers line for `nginx -t` / `systemctl reload nginx` and a root-owned
wrapper for compose, and change `remote_user` in the two test workflows.

The package catalogue is filled by CI, not by hand: on main, the **Packages**
workflow's `publish` job uploads the `.pkg` files it built and verified into
`/var/www/beanweb-pkgs` and checks their SHA-256 on the server. It runs when
`pkgs/` or the format changes; to fill an empty catalogue, run it by hand from
main (`gh workflow run packages.yml --ref main`). It never deletes: a package
dropped from `pkgs/` stays listed until someone removes the file on the
server, which is also how a package *not* built from `pkgs/` can live there.

### The host layer these files depend on

The site files here are short because the shared parts live on sysweb1 in
Ubuntu's own layout, maintained outside this repo (the `sysweb1` skill on the
maintainer's machine holds the sources and the install scripts):

| On sysweb1 | What it does |
|---|---|
| `sites-available/catch-all` | the only `default_server`. Port 80 for **every** hostname: Let's Encrypt challenges, then 301 to https. Port 443 for unknown names: TLS handshake refused. Site files therefore have no port-80 block. The package's `default` site is disabled, its file left in place. |
| `snippets/https.conf` | `listen 443 ssl` (v4 + v6), `http2 on`, challenges on 443 too, `server_tokens off` |
| `snippets/cloudflare.conf` | real visitor IPs (`snippets/cloudflare-realip.conf`) and the origin lock: anything not from Cloudflare's edge or loopback is closed with `444` -- no status, headers or page |
| `snippets/static-spa.conf` / `static.conf` | SPA fallback + cache headers / plain static files |
| `snippets/proxy.conf` | headers, HTTP/1.1 and WebSocket upgrade for a `proxy_pass` to a container |
| `conf.d/sysweb1.conf` | `log_format vhost`, gzip types, TLS session cache, the `$connection_upgrade` map |
| `conf.d/cloudflare-geo.conf` | the `$from_cloudflare` map. It keys on `$realip_remote_addr`: the real-IP rewrite runs before access checks, so a plain `allow`/`deny` of Cloudflare's ranges would refuse every visitor |

**The origin is anonymous to direct visitors.** Hit by IP or by the
machine's own name (`sysweb1.halicode.com`) instead of through Cloudflare:

| Request | Response |
|---|---|
| `http://5.135.7.243/`, `http://sysweb1.halicode.com/` (any path) | connection closed, empty reply |
| `https://5.135.7.243/`, `https://sysweb1.halicode.com/` | TLS handshake refused, no certificate shown |
| `https://` with a real site's name forced to the IP | that site's certificate, then the connection is closed |

The last row is the one thing a direct hit can learn, and only for a name it
already knows -- a server cannot withhold its certificate from a client that
asks for it by name. Through Cloudflare, the `Server` header is Cloudflare's
and error pages say only `nginx` (`server_tokens off` per server block).

`nginx.conf` and `sites-available/default` are the package's and are not
edited. `/root/README-letsencrypt.txt` on the box explains certificates.

### Certificate (Let's Encrypt, HTTP-01 webroot)

The catch-all answers challenges for any name, so a certificate can be issued
as soon as the Cloudflare record points at sysweb1 -- before the site file
exists:

```bash
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  --cert-name beanweb-test -d beanweb-test.halicode.com \
  --deploy-hook 'systemctl reload nginx'
sudo certbot renew --dry-run --no-random-sleep-on-renew --cert-name beanweb-test
```

`certbot.timer` renews it, and the deploy hook reloads nginx afterwards.

### nginx site file

`deploy/nginx/<hostname>` is installed as
`/etc/nginx/sites-available/<hostname>` and symlinked into `sites-enabled/`,
then `nginx -t` and a **reload** (never a restart -- other sites share this
nginx). The skill's `install-site.sh` does exactly that, with a backup of
`/etc/nginx` and an automatic restore if the test fails:

```bash
install-site.sh deploy/nginx/beanweb-test.halicode.com
```

Then set Cloudflare's SSL mode to **Full (strict)**.

### Deploy key and secrets

```bash
ssh-keygen -t ed25519 -C beanweb-test-deploy -f beanweb_test_deploy -N ''
# append beanweb_test_deploy.pub to ~ci/.ssh/authorized_keys on sysweb1
gh secret set SERVER_IP  --env test --body 5.135.7.243
gh secret set SERVER_KEY --env test < beanweb_test_deploy
```

Leave the `production` secrets alone until prod moves.

## Prod

Prod is the same setup with `deploy/nginx/beanweb.halicode.com` (root
`/var/www/beanweb`, backend `127.0.0.1:8080`, cert name `beanweb`) and the
`production` environment's own key. Both prod workflows stay manual
(`workflow_dispatch`): `gh workflow run deploy-prod.yml` and
`gh workflow run deploy-coffeeshop-prod.yml`.

The reusable workflows still carry an `apache` branch and defaults that match
the legacy Apache box, kept only as a way back while that box still exists.
Once it is decommissioned, drop the branch and make the sysweb1 values the
defaults.
