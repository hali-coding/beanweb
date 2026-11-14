##
# beanweb.halicode.com -- BeanWeb prod (hali-coding/beanweb), on sysweb1.
#
# Installed by hand as /etc/nginx/sites-available/beanweb.halicode.com
# (see deploy/README.md).
# The shared parts live on the host, in snippets/: https.conf (443 + http2 +
# Let's Encrypt), cloudflare.conf (real IP + Cloudflare-only origin lock),
# static-spa.conf and proxy.conf. Port 80 is the host's catch-all.
##

server {
	server_name beanweb.halicode.com;
	include snippets/https.conf;

	ssl_certificate /etc/letsencrypt/live/beanweb/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/beanweb/privkey.pem;

	include snippets/cloudflare.conf;
	access_log /var/log/nginx/beanweb.access.log vhost;
	error_log /var/log/nginx/beanweb.error.log;

	root /var/www/beanweb;
	include snippets/static-spa.conf;

	# Coffee Shop backend (Docker, compose project beanweb-coffeeshop)
	location /api/coffeeshop {
		proxy_pass http://127.0.0.1:8080;
		include snippets/proxy.conf;
	}
}
