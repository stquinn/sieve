const htmxModule = require('htmx.org');
window.htmx = htmxModule.default || htmxModule;
require('htmx-ext-sse');
