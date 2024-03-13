import { ChildProcessWithoutNullStreams, spawn, exec, execSync } from "child_process";
import { networkInterfaces, hostname } from "os";
import { platform } from "process";
import { EventEmitter } from "events";
import {
	IDebugData,
	IDebugOptions,
	IDeviceDebugService,
	IDebugResultInfo,
} from "../definitions/debug";

function isRunning(win: string, mac: string, linux: string) {
	return new Promise(function (resolve, reject) {
		const plat = process.platform
		const cmd = plat == 'win32' ? 'tasklist' : (plat == 'darwin' ? 'pgrep -ifl ' + mac : (plat == 'linux' ? 'ps -A' : ''))
		const proc = plat == 'win32' ? win : (plat == 'darwin' ? mac : (plat == 'linux' ? linux : ''))
		if (cmd === '' || proc === '') {
			resolve(false)
		}
		exec(cmd, function (err, stdout, stderr) {
			resolve(stdout.toLowerCase().indexOf(proc.toLowerCase()) > -1)
		})
	})
}

// // Launch and close devtools without using Chrome Remote Debugging protocol
// // - localhost server serves our little web app which just shows chrome-devtools-frontend.appspot.com in an iframe
// // - That little web app also keeps a websocket open WITH the cli process listening for commands
// // Commands:
// // - Refresh - refresh the iframe (upon restart of the app) so it reconnects to the target
// // - Close - close the iframe (upon closing the CLI) so we dont leave windows open
// // 

// const devtoolsPage = `<!DOCTYPE html>
// <html lang="en">
// <head>
//     <title>NativeScript DevTools Frontend</title>
//     <style>
//         html, body {
//             margin: 0;
//             width: 100%;
//             height: 100%;
//         }
//     </style>
// </head>
// <body>
//     <!-- javascript:window.open(%27https://messenger.com%27,%20%27_blank%27,%20%27toolbar,scrollbars,resizable,top=0,left=0,width=1440,height=1440%27); -->
//     <!-- window.open("localhost:__DEVTOOLS_PROXY_PORT__/index.html", "_blank", \`toolbar, scrollbars, resizable, top = 0, left = 1, width = \${Math.min(1440, screen.availWidth / 2)}, height = \${screen.availHeight}\`) -->
//     <iframe id="iframe" src=""
//         frameborder="0"
//         style="width: 100%; height: 100%;"></iframe>

// 	<script>
// 		const iframeURLBase = location.origin + '/serve_file/@f586f4aac99e265d53185eb4abda1af76b668292/inspector.html?ws='
	
// 		const ws = new WebSocket('ws://' + location.hostname + ':8081')
// 		ws.onopen = function () {
// 			console.log('Websocket client connected')
// 		}
// 		ws.onmessage = function (event) {
// 			console.log('Websocket client got message', event)
// 			const { data: port } = event
// 			const iframe = document.getElementById('iframe')
// 			const newiFrameURL = iframeURLBase + window.location.hostname + ':' + port
// 			if (iframe.src !== newiFrameURL) {
// 				iframe.src = newiFrameURL
// 				console.log('Set iframe src to', iframe.src)
// 			} else {
// 				// This will cause a reload of the iframe
// 				document.getElementById('iframe').src += ''
// 			}
// 		}
// 	</script>
// </body>
// </html>
// `

// import { createServer, request } from 'http'
// import * as path from 'path'
// import * as fs from 'fs'
// const cacheDir = path.join(process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp', 'nativescript-devtools-cache')
// const cacheFile = path.join(cacheDir, 'cache.json')
// createServer(async function (req, res) {
// 	console.log(`Handling request from ${req.connection.remoteAddress} with url ${req.url}`)
// 	// If the request is to any /serve_file path, proxy it to the devtools server
// 	if (req.url.startsWith('/serve_file')) {
// 		const devtoolsServer = 'http://chrome-devtools-frontend.appspot.com'
// 		// Check if we have a response for this file cached
// 		try {
// 			var cache: { [url: string]: { headers: any, status: number, body: string } } = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
// 		} catch (error) {
// 			console.log(`Unable to load cache file: ${error.message}`)
// 			cache = {}
// 		}
// 		const cacheEnt: { headers: any, status: number, body: string } = cache[req.url] || await new Promise(async resolve => {
// 			// TODO WARN: the callback here is never being called - the request is to the http://
// 			// and we are using the `request` function from 'http', but when you access this URL in
// 			// the browser you are redirected to https so maybe a matter of `request` not being able
// 			// to handle the upgrade or SSL or something
// 			const devtoolsReq = request(devtoolsServer + req.url, (devtoolsRes) => {
// 				const chunks = []
// 				devtoolsRes.on('data', (chunk) => {
// 					chunks.push(chunk)
// 					console.log(`Read ${chunk.length} bytes from devtools server upon 'data':${chunk.toString()}`)
// 				})
// 				// Cache the response for next time
// 				// Read the whole repsonse and save the cache entry
// 				devtoolsRes.on('end', () => {
// 					console.log(`End of stream:\n`, chunks.map(c => c.toString()).join())
// 					const body: string = devtoolsRes.read().toString()
// 					console.log(`Read ${body.length} bytes from devtools server upon 'end':${body.toString()}`)
// 					resolve(cache[req.url] = {
// 						headers: devtoolsRes.headers,
// 						status: devtoolsRes.statusCode,
// 						body
// 					})
// 					// Update the cache file
// 					fs.writeFileSync(cacheFile, JSON.stringify(cache))
// 				})
// 			})
// 		})
// 		res.writeHead(cacheEnt.status, cacheEnt.headers)
// 		res.end(cacheEnt.body)
// 	} else {
// 		res.writeHead(200, { "Content-Type": "text/html" })
// 		res.end(devtoolsPage)
// 	}
// }).listen(8080, '0.0.0.0');

// import * as WebSocket from 'ws'
// const wss = new WebSocket.Server({ port: 8081, host: '0.0.0.0' })
// const wsClients = new Set<WebSocket>()
// wss.on('connection', function connection(ws) {
// 	console.log(`Websocket server got connection`)
// 	wsClients.add(ws)
// 	ws.send(41000)
// 	ws.on('message', function incoming(message) {
// 		console.log('received: %s', message)
// 	})
// });

const CHROME_RDP_PORT = 9333
export abstract class DebugServiceBase
	extends EventEmitter
	implements IDeviceDebugService {
	constructor(
		protected device: Mobile.IDevice,
		protected $devicesService: Mobile.IDevicesService
	) {
		super();
	}

	public abstract get platform(): string;

	public abstract debug(
		debugData: IDebugData,
		debugOptions: IDebugOptions
	): Promise<IDebugResultInfo>;

	public abstract debugStop(): Promise<void>;

	protected getCanExecuteAction(
		deviceIdentifier: string
	): (device: Mobile.IDevice) => boolean {
		return (device: Mobile.IDevice): boolean => {
			if (deviceIdentifier) {
				let isSearchedDevice =
					device.deviceInfo.identifier === deviceIdentifier;
				if (!isSearchedDevice) {
					const deviceByDeviceOption = this.$devicesService.getDeviceByDeviceOption();
					isSearchedDevice =
						deviceByDeviceOption &&
						device.deviceInfo.identifier ===
							deviceByDeviceOption.deviceInfo.identifier;
				}

				return isSearchedDevice;
			} else {
				return true;
			}
		};
	}

	protected getChromeDebugUrl(
		debugOptions: IDebugOptions,
		port: number
	): string {
		const devicePlatform = this.$devicesService.platform.toLowerCase()
		// Copy/replace after this line for development/testing -----------------------------------------------------------------------------------------------------------------------

		// corresponds to 82.0.4084.2 Chrome version
		// Last version that has working autocomplete for android
		// SHA is taken from https://chromium.googlesource.com/chromium/src/+/82.0.4084.2.100
		// In case we want to stick with concrete SHA, get it from one of the tags https://chromium.googlesource.com/chromium/src/
		// IMPORTANT: When you get the SHA, ensure you are using the `parent` commit, not the actual one.
		// Using the actual commit will result in 404 error in the remote serve.
		const commitSHA =
			devicePlatform === 'android'
				? "73ee5087001dcef33047c4ed650471b225dd8caf"  // Chromium 88.0.4324.182
				: "73ee5087001dcef33047c4ed650471b225dd8caf"  // Chromium 88.0.4324.182 - exact version installed on Mac and still dodgy when we use chrome-devtools-frontend.appspot.com...?

		// iOS V8 runtime should be compatible with the latest devtools build included with Chrome,
		// Android runtime we need an older matching devtools version
		const devToolsProtocol = `devtools`;
		let chromeDevToolsPrefix = devicePlatform === 'android'
			? `https://chrome-devtools-frontend.appspot.com/serve_file/@${commitSHA}`
			// Autocomplete does not seem to work on bundled devtools with --debug-brk on iPhone 6S or iPhone 12 (2021-06-06)
			// : (process.platform === 'darwin')
			// 	? `${devToolsProtocol}://devtools/bundled`  // This one works fine on Mac + iOS but not windows + iOS - just sits on google homepage 
			: `${devToolsProtocol}://devtools/remote/serve_file/@${commitSHA}`;  // Strangely the equivalent chrome-devtools-frontend URL has issues with autocomplete?... Not sure that this actually serves that particular version or just uses the bundled one

		const chromeUrl = `${chromeDevToolsPrefix}/inspector.html?ws=127.0.0.1:${port}`
		const CDP = require('chrome-remote-interface');
		const CDPOpts = { host: '127.0.0.1', port: CHROME_RDP_PORT }
		let initialUrl = devicePlatform === 'ios' ? 'https://ns-cli-devtools-temp-page/' : chromeUrl

		async function launchNewChromeWindow() {
			// This option is not needed assuming you have configured your Chrome to ALWAYS launch
			// with the flag --remote-debugging-port=####, or the instance that's launched by this
			// script is the first one running.
			/* "--user-data-dir=C:/chrome-scrap-profile/" */

			// Chrome refuses to open a --app window for a devtools:// url directly, so unless we
			// are using the https://chrome-devtools-frontend.appspot.com url, we first load
			// any other page and then navigate to the actual devtools:// url
			const commonFlags = [`--app=${initialUrl}`, `--remote-debugging-port=${CHROME_RDP_PORT}`]  // Warning: Do not add --profile-directory=\"Profile 1\". Will confuse chrome with profiles or it wont launch entirely
			console.log({ "Chrome args": commonFlags.join(' ') });

			let result: ChildProcessWithoutNullStreams
			switch (platform) {
				case 'win32':
					result = spawn("C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", [`/new-window`, ...commonFlags], {
						detached: true
					})
					break;
				case 'darwin':
					// open -b with bundle identifier ensures Chrome still launches if the user has
					// renamed Google Chrome.app to something else
					result = spawn("open", ['-n', '-b', 'com.google.Chrome', '--args', `--new-window`, ...commonFlags], {
						detached: true
					})
					break
				default:
					throw new Error('Unsupported platform')
			}

			// Will exit if chrome was already running, will emit a message about devtools to stderr if new instance
			await new Promise((resolve, reject) => {
				result.on('exit', code => {
					if (code !== 0)
						reject(new Error(`non-0 exit code ${code}`))
					else
						resolve(true)
				})
				const stdioHandler = (buf: any) => {
					resolve(true)
					result.stdout.off('data', stdioHandler)
					result.stderr.off('data', stdioHandler)
				}
				result.stdout.on('data', stdioHandler)
				result.stderr.on('data', stdioHandler)
				setTimeout(resolve, 1000)  // Fallback
			})
		}

		const openOrReloadDevtools = async () => {
			// FOR CDP DOCUMENTATION refer to https://vanilla.aslushnikov.com/
			// Or https://chromedevtools.github.io/devtools-protocol/tot/Page/
			// And for chrome-remote-interface https://github.com/cyrus-and/chrome-remote-interface

			// Handle the case where Chrome is not running at all
			let tabs;
			try {
				// Throws ECONNREFUSED if Chrome is not already running with --remote-debugging-port
				tabs = (await CDP.List(CDPOpts)).filter((t: any) => /inspector.html\?ws=/.test(t.url) && t.url.endsWith(port) || t.url === initialUrl.toLowerCase())
				console.log(`Existing tab(s):`, tabs.map((t: any) => t.url));

				if (!tabs?.length)
					await launchNewChromeWindow()
				// else if (!process.argv.includes('--no-hmr') && !process.argv.includes('--debug-brk')) // If HMR enabled dont relaunch/reload
				// 	return console.log(`openChrome not launching or closing windows since --no-hmr not specified`)
				// TODO: handle when HMR enabled and an app restart is actually done
			} catch (error) {
				// If the client has not been launched we launch it
				if (error.code === 'ECONNREFUSED') {
					// Check chrome isnt actually running without remote debugging enabled. NOTE
					// "chrome" matches chrome_crashpad_handler in Slack, Visual Studio code on
					// MacOS
					if (await isRunning('chrome.exe', 'Google Chrome', 'chrome')) {
						throw new Error(`Chrome appears to be running but not with --remote-debugging-port=${CHROME_RDP_PORT}`)
					} else {
						await launchNewChromeWindow()
					}
				} else {
					throw error
				}
			}


			// Now guaraunteed there was an existing window with devtools open (which we now need to
			// reload), or one is being opened. Since windows cannot be opened to a devtools:// url
			// directly, we may need to wait for/find the target on the initialUrl and navigate it to the
			// devtools:// url. Note this is not the case for https://chrome-devtools-frontend.appspot.com
			if (tabs?.length || initialUrl !== chromeUrl) {  // Otherwise 
				const client: any = await CDP(CDPOpts)
				let target = tabs?.length
					? { ...tabs[0], targetId: tabs[0].id }
					: await new Promise((resolve, reject) => {
						let targetCreatedHandler: any
						const targetFoundOrTimeout = (target: any | null) => {
							client.off('Target.targetCreated', targetCreatedHandler)  // Assume we dont need this if we just do client.close() ?
							// client.Target.setDiscoverTargets({ discover: false })  // DON'T add this, it only causes errors
							if (!target) {
								reject(new Error(`Timeout waiting for Target.targetCreated event`))
							} else {
								resolve(target)
							}
						}
						client.on('Target.targetCreated', targetCreatedHandler = async ({ targetInfo: target }: any) => {
							if (target.url === chromeUrl || target.url === initialUrl.toLowerCase())
								targetFoundOrTimeout(target)
						})
						client.Target.setDiscoverTargets({ discover: true })
						setTimeout(targetFoundOrTimeout, 5000)
					})
				const { sessionId } = await client.Target.attachToTarget(target)
				// TODO: sendMessageToTarget is DEPRECATED. See https://github.com/cyrus-and/chrome-remote-interface/issues/439, https://github.com/aslushnikov/getting-started-with-cdp#targets--sessions, https://github.com/cyrus-and/chrome-remote-interface/pull/441,
				// The only other way to make sure the Page.navigate message goes to the RIGHT page might be to turn off auto attach with client.Target.setAutoAttach, make sure we have called client.Target.detachFromTarget for all targets that are automatically attached and then ONLY attach to the target for the chromeUrl or initialUrl page, and THEN try issuing the client.Page.navigate. A lot more work than just telling it which sessionId we want to send the navigate command to though... Alternately we need this to be merged so we can send a regular Page.navigate but also specify the sessionId: https://github.com/cyrus-and/chrome-remote-interface/pull/441 (the implementation below uses a deprecated special "non-flattened" way of doing this via Target.sendMessageToTarget rather than being able to do something like client.send({ id: ..., sessionid: ..., command: 'Page.navigate', params: { url: ...} })
				
				// await new Promise(res => setTimeout(res, 75))

				await Promise.all([
					client.Target.sendMessageToTarget({
						sessionId,
						// Lucked out on the syntax of this one, message is just a JSON string representing the command we'd usually send via client[Domain][method](params) that allows us to also specify the sessionId (something that chrome-remote-interface doesn't support otherwise)
						message: JSON.stringify({
							id: 1, // Note that IDs are independent between sessions.
							method: target.url === chromeUrl ? 'Page.reload' : 'Page.navigate',  // If the target is already on the devtools page just reload it - may be faster for chrome-devtools-frontend.appspot.com
							params: { url: chromeUrl },
						})
					}),
					// Close all other copies of the page
					...tabs?.slice(1).map((t: any) => client.Target.closeTarget({ targetId: t.id })) || []
					// client.Target.activateTarget(target)
				])
				console.log(`Sent, calling close()`)
				await client.close()
				console.log(`close() returned`)
			}
		}

		if (!process.argv.includes('--skip-launch-devtools')) { // Support explicitly disabling auto launch of devtools
			openOrReloadDevtools().catch(err => {
				console.error(`Error opening chrome to debugging url:`, err);
			})
		} else {
			console.log(`--skip-launch-devtools specified. Not launching or reloading devtools window`)
		}

		/** Get a list of NIC IP addresses */
		let extNics = Object.entries(networkInterfaces())
			.flatMap(e => e[1].map(iface => ({ ifName: e[0], ...iface })))
			.filter(iface => iface.family === 'IPv4' && iface.internal === false)
			
		// On MacOS and linux we can use netstat to infer what the primary NIC is and only print that one
		if (process.platform === 'darwin' || process.platform === 'linux') {
			const routes = execSync('netstat -nr').toString().split('\n').filter(l => /^0\.0\.0\.0|default/.test(l))
			for (const r of routes) {
				const ip = extNics.find(a => r.trim().endsWith(a.ifName))
				if (ip) {
					extNics = [ip]
					console.log(`Found primary NIC: ${ip.ifName} (${ip.address})`)
					break
				}
			}
		}

		console.log(`DevTools URLs:`)
		for (const addr of extNics)
			console.log(`\t${addr.ifName} (${addr.address}):`, chromeUrl.replace(/(?<=ws=)[^:]+/, addr.address).blue.underline);
		process.stdout.write(`\n`)

		// Dont copy/replace this ------------------------------------------------------------------------------------------------------------
		return chromeUrl;
	}
}
