##
# beanweb-test.halicode.com -- BeanWeb test (hali-coding/beanweb), on sysweb1.
#
# Installed by hand as /etc/nginx/sites-available/beanweb-test.halicode.com
# (see deploy/README.md).
# The shared parts live on the host, in snippets/: https.conf (443 + http2 +
# Let's Encrypt), cloudflare.conf (real IP + Cloudflare-only origin lock),
# static-spa.conf and proxy.conf. Port 80 is the host's catch-all.
##

server {
	server_name beanweb-test.halicode.com;
	include snippets/https.conf;

	ssl_certificate /etc/letsencrypt/live/beanweb-test/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/beanweb-test/privkey.pem;

	include snippets/cloudflare.conf;
	access_log /var/log/nginx/beanweb-test.access.log vhost;
	error_log /var/log/nginx/beanweb-test.error.log;

	root /var/www/beanweb-test;
	include snippets/static-spa.conf;

	# Coffee Shop backend (Docker, compose project beanweb-coffeeshop-test)
	location /api/coffeeshop {
		proxy_pass http://127.0.0.1:8081;
		include snippets/proxy.conf;
	}
}
