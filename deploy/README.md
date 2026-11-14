# Deploying BeanWeb

Two hosts during the move:

| Target | Host | Web server | Deploy user |
|---|---|---|---|
| test — `beanweb-test.halicode.com` | sysweb1 (shared with other sites) | nginx | `ci` |
| prod — `beanweb.halicode.com` | legacy box | Apache2 | `github` |

Both domains sit behind Cloudflare's proxy. The origin IP lives in two places
only: the Cloudflare DNS record and the GitHub environment secret `SERVER_IP`.

CI does the deploys (`.github/workflows/deploy-*.yml`). What CI does **not** do
is touch `/etc`: the nginx config, the certificate and sudoers are installed by
hand, once, from this directory.

## Names BeanWeb claims on sysweb1

Check these for collisions before installing — the host is shared.

| Kind | Name |
|---|---|
| Static roots | `/var/www/beanweb-test` (later `/var/www/beanweb`) |
| Coffee Shop source | `/var/www/beanweb-coffeeshop-test` (later `-coffeeshop`) |
| Package catalogue | `/var/www/beanweb-pkgs` (read-only mount, shared by test and prod) |
| Ports | `127.0.0.1:8081` test, `127.0.0.1:8080` prod |
| Compose project | `beanweb-coffeeshop-test` |
| nginx | `sites-available/beanweb-test.conf`, logs `beanweb-test.*` |
| Certificate | `--cert-name beanweb-test`, challenge webroot `/var/www/letsencrypt` |
| nginx snippet | `snippets/cloudflare-realip.conf` (generic, safe for other sites to include too) |
| nginx http map | `conf.d/cloudflare-geo.conf` → `$from_cloudflare` (generic) |

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

### Cloudflare: real visitor IPs and the origin lock

Two files built from the same published ranges. Re-run both when Cloudflare
changes them -- a range missing from the lock means visitors routed through it
get 403.

```bash
CF="$(curl -fsS https://www.cloudflare.com/ips-v4) $(curl -fsS https://www.cloudflare.com/ips-v6)"

# 1. real visitor IPs in the logs -- included per site, never in http{}
{ for r in $CF; do echo "set_real_ip_from $r;"; done
  echo 'real_ip_header CF-Connecting-IP;'; } \
  | sudo tee /etc/nginx/snippets/cloudflare-realip.conf

# 2. origin lock -- a variable only, so harmless to sites that never read it
{ echo 'geo $realip_remote_addr $from_cloudflare {'
  echo '    default 0;'; echo '    127.0.0.1/32 1;'; echo '    ::1/128 1;'
  for r in $CF; do echo "    $r 1;"; done; echo '}'; } \
  | sudo tee /etc/nginx/conf.d/cloudflare-geo.conf

sudo nginx -t && sudo systemctl reload nginx
```

The site file refuses anything else with `if ($from_cloudflare = 0) { return
403; }` in both server blocks -- the nginx form of the Apache `Allow from`
list. It cannot be `allow`/`deny`: the real-IP snippet rewrites `$remote_addr`
to the visitor before the access phase, so allow-listing Cloudflare's ranges
there would refuse every visitor. The geo map reads `$realip_remote_addr`, the
address that actually connected. IPv6 edge ranges are in the lock too (the
Apache list had only IPv4), and loopback is allowed so checks on the box work.

Let's Encrypt still validates: its challenge reaches the origin through
Cloudflare like any other request (`certbot renew --dry-run` passes with the
lock in place). Docker's published ports bypass nginx entirely, which is why
the Coffee Shop container binds `127.0.0.1`.

### Certificate (Let's Encrypt, HTTP-01 webroot)

Cloudflare passes plain-http requests through to the origin, so the challenge
reaches nginx's port-80 block. Until the certificate exists, install only a
port-80 server block (the 443 block cannot load without its key) that serves
`/.well-known/acme-challenge/` from `/var/www/letsencrypt`, then:

```bash
sudo mkdir -p /var/www/letsencrypt
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  --cert-name beanweb-test -d beanweb-test.halicode.com \
  --deploy-hook 'systemctl reload nginx'
sudo certbot renew --dry-run
```

`certbot.timer` renews it. Both server blocks keep serving the challenge
path, so renewal survives Cloudflare being switched to *Always Use HTTPS*.
DNS-01 (`python3-certbot-dns-cloudflare`, installed) is the fallback if
Cloudflare ever stops passing the challenge through; it needs an API token
scoped to Zone -> DNS -> Edit on halicode.com, kept in
`/root/.secrets/cloudflare.ini` (mode 600).

### nginx

```bash
sudo cp deploy/nginx/beanweb-test.conf /etc/nginx/sites-available/
sudo ln -s ../sites-available/beanweb-test.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx     # reload, never restart
curl -I --resolve beanweb-test.halicode.com:443:5.135.7.243 https://beanweb-test.halicode.com/
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

## Moving prod later

Repeat the setup with `beanweb.conf` (copy of the test file: `server_name
beanweb.halicode.com`, root `/var/www/beanweb`, port 8080, cert name
`beanweb`), set the `production` secrets, then in `deploy-prod.yml` pass
`remote_user: ci` and `web_server: nginx`, and in `deploy-coffeeshop-prod.yml`
pass `remote_user: ci`, `pkg_host_dir: /var/www/beanweb-pkgs`,
`bind_addr: 127.0.0.1` and `compose_project: beanweb-coffeeshop`. Point the
Cloudflare record at sysweb1 last — a proxied record switches at once. Once
nothing deploys to the legacy box, drop the `apache` branch and the
legacy defaults from the reusable workflows.
