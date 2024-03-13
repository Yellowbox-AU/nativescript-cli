import { EventEmitter } from "events";
import { CONNECTION_ERROR_EVENT_NAME } from "../../constants";
import * as net from "net";
import * as ws from "ws";
import { MessageUnpackStream } from "ios-device-lib";
import { IAppDebugSocketProxyFactory, IiOSSocketRequestExecutor, IOptions } from "../../declarations";
import * as constants from "../../constants"
import { IDictionary, IErrors, INet } from "../../common/declarations";
import { injector } from "../../common/yok";
import { ITempService } from "../../definitions/temp-service";
import { sleep } from "../../common/helpers"
import { IncomingMessage } from "http"
import chalk = require("chalk")

export class AppDebugSocketProxyFactory
	extends EventEmitter
	implements IAppDebugSocketProxyFactory
{
	private deviceWebServersInitialising: IDictionary<Promise<ws.Server>> = {};
	private deviceWebServers: IDictionary<ws.Server> = {};
	private deviceTcpServers: IDictionary<net.Server> = {};

	constructor(
		private $logger: ILogger,
		private $errors: IErrors,
		private $lockService: ILockService,
		private $options: IOptions,
		private $tempService: ITempService,
		private $net: INet,
		private $iOSDebuggerPortService: IIOSDebuggerPortService,
		private $iOSSocketRequestExecutor: IiOSSocketRequestExecutor,
	) {
		super();
	}

	public getTCPSocketProxy(
		deviceIdentifier: string,
		appId: string
	): net.Server {
		return this.deviceTcpServers[`${deviceIdentifier}-${appId}`];
	}

	public async addTCPSocketProxy(
		device: Mobile.IiOSDevice,
		appId: string,
		projectName: string,
		projectDir: string
	): Promise<net.Server> {
		const cacheKey = `${device.deviceInfo.identifier}-${appId}`;
		const existingServer = this.deviceTcpServers[cacheKey];
		if (existingServer) {
			this.$errors.fail(
				`TCP socket proxy is already running for device '${device.deviceInfo.identifier}' and app '${appId}'`
			);
		}

		this.$logger.info(
			"\nSetting up proxy...\nPress Ctrl + C to terminate, or disconnect.\n"
		);

		const server = net.createServer({
			allowHalfOpen: true,
		});

		this.deviceTcpServers[cacheKey] = server;

		server.on("connection", async (frontendSocket: net.Socket) => {
			this.$logger.info("Frontend client connected.");
			frontendSocket.on("end", () => {
				this.$logger.info("Frontend socket closed!");
				if (!this.$options.watch) {
					process.exit(0);
				}
			});

			const appDebugSocket = await device.getDebugSocket(
				appId,
				projectName,
				projectDir
			);
			this.$logger.info("Backend socket created.");

			appDebugSocket.on("end", () => {
				this.$logger.info("Backend socket closed!");
				if (!this.$options.watch) {
					process.exit(0);
				}
			});

			frontendSocket.on("close", async () => {
				this.$logger.info("Frontend socket closed");
				await device.destroyDebugSocket(appId);
			});

			appDebugSocket.on("close", () => {
				this.$logger.info("Backend socket closed");
				frontendSocket.destroy();
				server.close();
				delete this.deviceTcpServers[cacheKey];
			});

			appDebugSocket.pipe(frontendSocket);
			frontendSocket.pipe(appDebugSocket);
			frontendSocket.resume();
		});

		const socketFileLocation = await this.$tempService.path({
			suffix: ".sock",
		});
		server.listen(socketFileLocation);
		if (!this.$options.client) {
			this.$logger.info("socket-file-location: " + socketFileLocation);
		}

		return server;
	}

	public async ensureWebSocketProxy(
		device: Mobile.IiOSDevice,
		appId: string,
		projectName: string,
		projectDir: string
	): Promise<ws.Server> {
		const cacheKey = `${device.deviceInfo.identifier}-${appId}`;
		const existingWebProxy = this.deviceWebServers[cacheKey];
		// There is an async delay obtaining an avilable port to setup the proxy on, during which
		// this function could be invoked again. Use deviceWebServersInitialising to prevent
		// creation of multiple web socket proxies for the same device/app during this time.
		let result =
			existingWebProxy ||
			(cacheKey in this.deviceWebServersInitialising &&
				(await this.deviceWebServersInitialising[cacheKey]));
		if (!result) {
			result = await (this.deviceWebServersInitialising[
				cacheKey
			] = this.addWebSocketProxy(device, appId, projectName, projectDir));
			delete this.deviceWebServersInitialising[cacheKey];
		}

		// TODO: do not remove till VSCode waits for this message in order to reattach
		this.$logger.info("Opened localhost " + result.options.port);

		return result;
	}

	private async addWebSocketProxy(
		device: Mobile.IiOSDevice,
		appId: string,
		projectName: string,
		projectDir: string
	): Promise<ws.Server> {
		let clientConnectionLockRelease: () => void;
		const cacheKey = `${device.deviceInfo.identifier}-${appId}`;
		const existingServer = this.deviceWebServers[cacheKey];
		if (existingServer) {
			this.$errors.fail(
				`Web socket proxy is already running for device '${device.deviceInfo.identifier}' and app '${appId}'`
			);
		}

		// NOTE: We will try to provide command line options to select ports, at least on the localhost.
		const localPort = await this.$net.getAvailablePortInRange(41000);

		this.$logger.info(
			`\naddWebSocketProxy Got available port ${localPort} for Setting up debugger proxy to ${appId}...\nPress Ctrl + C to terminate, or disconnect.\n`
		);

		// NB: When the inspector frontend connects we might not have connected to the inspector backend yet.
		// That's why we use the verifyClient callback of the websocket server to stall the upgrade request until we connect.
		// We store the socket that connects us to the device in the upgrade request object itself and later on retrieve it
		// in the connection callback.

		let currentAppSocket: net.Socket = null;
		let currentWebSocket: ws = null;
		const server = new ws.Server(<any>{
			port: localPort,
			host: "0.0.0.0",
			verifyClient: async (
				info: {
					/** E.g. 'devtools://devtools' */
					origin: string,
					req: IncomingMessage & { __deviceSocket: net.Socket }
				},
				callback: (res: boolean, code?: number, message?: string) => void
			) => {
				console.log(`verifyClient`)
				let acceptHandshake = true;
				clientConnectionLockRelease = null;

				try {
					clientConnectionLockRelease = await this.$lockService.lock(
						`debug-connection-${device.deviceInfo.identifier}-${appId}.lock`
					);
					
					global.frontendWaitingPort = true
					this.$logger.info(`Node websocket v8 inspector proxy server verifyClient() for conn from ${info.req.connection.remoteAddress} origin ${info.origin}... accepting handshake after getting debug port from device logs and using this to either open USB mux connection to socket on device via ios-device-lib or open tcp socket to device via bonjour`)
					const logCentered = (linePairs: string[]) => {
						const longest = Math.max(...linePairs.flatMap(lPair => lPair.split('\n').map(l => l.length)))
						const space = ' '.repeat(longest / 2)
						console.log('\n' + chalk.green(linePairs.map(lp => lp.split('\n').map(l => ' '.repeat(longest / 2 - l.length / 2) + l).join('\n')).join(`\n${space}|\n${space}v\n`)) + '\n')
					}
					logCentered([
						`Devtools Frontend\n${info.req.connection.remoteAddress}:${info.req.connection.remotePort} (origin ${info.origin})`,
						`Websocket Proxy Server (CLI)\n${info.req.connection.localAddress}:${info.req.connection.localPort}\n`
					])
					let appDebugSocket: net.Socket;
					console.log(`verifyClient: about to getDebugSocket. global.lastSeenPort = ${global.lastSeenPort}. global.frontendWaitingPort = ${global.frontendWaitingPort}. currentAppSocket = ${currentAppSocket}. currentWebSocket = ${currentWebSocket}.`)
					// Assume we need to destroy the socket and create a new one for v8-inspector
					// and the new devtools frontend to properly initialise the new session,
					// otherwise the frontend would probably be waiting for some metadata about the
					// connection/target upon connecting which v8-inspector thinks it has already
					// sent?
					if (currentAppSocket) {
						currentAppSocket.removeAllListeners();
						currentAppSocket = null;
						if (currentWebSocket) {
							currentWebSocket.removeAllListeners();
							currentWebSocket.close();
							currentWebSocket = null;
						}
						await device.destroyDebugSocket(appId);
					}
					// Upon calling this we trigger an attachRequest, causing the cli to log another
					// port number, which triggers our initial global log filter thing
					
					if (device.isOnlyWiFiConnected) {
						// Prefer using bonjour to discover the host (via .local), which is
						// generally more reliable e.g. ben-iphone-13 can't be resolved when macbook
						// is connected to hotspot but with .local we have no issues.
						const hostname = device.deviceInfo.displayName + '.local'
						if (!global.lastSeenPort) {
							// We're basically going to do the same thing getDebugSocket below would
							// do in the case there was no global.lastSeenPort defined, but without
							// having ios-device-lib actually connect to the port for us so that we
							// can est. a direct LAN connection instead
							// Make sure we have setup the log filters to catch the emitted port for
							// when we send the attachRequest
							await device.attachToDebuggerFoundEvent(appId, projectName, projectDir)
							// Send the attachRequest notification to the device so it will print
							// another debug port (noting we have prevented the main log filter from
							// actioning the log by setting global.frontendWaitingPort = true above
							// to prevent that interfering here)
							await this.$iOSSocketRequestExecutor.executeAttachRequest(device, constants.AWAIT_NOTIFICATION_TIMEOUT_SECONDS, appId);
							// Pick up the emitted port - not sure why this has to be so complicated
							// all 3 of these things should really just be one function surely
							global.lastSeenPort = await this.$iOSDebuggerPortService.getPort({
								appId,
								deviceId: device.deviceInfo.identifier
							})
							console.log(chalk.green(`Successfully got new port ${global.lastSeenPort} via iOSDebuggerPortService`))
						}
						appDebugSocket = await new Promise(resolve => {
							const socket = net.createConnection({
								// EHOSTUNREACH fe80::8a7:d006:7b53:2b5f:18183 without this
								family: 4,
								host: hostname,
								port: global.lastSeenPort
							}, () => {
								this.$logger.info(`createConnection to socket on ${hostname} succeeded`);
								logCentered([
									`CLI Process\n${socket.localAddress}:${socket.localPort}`,
									`InspectorServer running on device (${hostname})\n${socket.remoteAddress}:${socket.remotePort}`,
								])
								resolve(socket)
							})
						})
					} else {
						appDebugSocket = await device.getDebugSocket(
							appId,
							projectName,
							projectDir
						);
						logCentered([
							`ios-device-lib proxy server (C++ binary)\n${appDebugSocket.remoteAddress}:${appDebugSocket.remotePort}`,
							`USBMuxConnectByPort muxed connection\nPort ${global.lastSeenPort}? on ${device.deviceInfo.displayName}`
						])
					}
					
					currentAppSocket = appDebugSocket;
					this.$logger.info("Backend socket created.");
					info.req["__deviceSocket"] = appDebugSocket;
				} catch (err) {
					if (clientConnectionLockRelease) {
						clientConnectionLockRelease();
						global.frontendWaitingPort = false
					}
					err.deviceIdentifier = device.deviceInfo.identifier;
					this.$logger.trace(err);
					this.emit(CONNECTION_ERROR_EVENT_NAME, err);
					acceptHandshake = false;
					this.$logger.warn(
						`verifyClient: Cannot connect to device socket. The error message is '${err.message}'.`
					);
				}
		
		// Fires on a connection to the ACTUAL websocket server, whereas verifyClient is like the
		// initial handshake connection following which the request gets upgraded to a websocket
		// connection and we will move here. During that handshake we capture and save the
		// appDebugSocket in the __deviceSocket key where it can be restored here

				callback(acceptHandshake);
			},
		});
		this.deviceWebServers[cacheKey] = server;
		server.on("connection", (webSocket, req) => {
			currentWebSocket = webSocket;
			const encoding = "utf16le";
			
			const appDebugSocket: net.Socket = (<any>req)["__deviceSocket"];
			// Note we are not proxying to the socket ON the device, we go via ANOTHER socket
			// created by ios-device lib which uses USBMuxConnectByPort to connect through to the
			// actual TCP socket on the device

			const packets = new MessageUnpackStream();
			appDebugSocket.pipe(packets);

			packets.on("data", (buffer: Buffer) => {
				const message = buffer.toString(encoding);
				if (webSocket.readyState === webSocket.OPEN) {
					if (process.env.DEBUG_DEVTOOLS_SOCKETS) {
						console.log({
							msgFromRuntime: JSON.parse(message),
						});
					}
					webSocket.send(message);
				} else {
					this.$logger.trace(
						`Received message ${message}, but unable to send it to webSocket as its state is: ${webSocket.readyState}`
					);
				}
			});

			webSocket.on("error", (err) => {
				this.$logger.trace("Error on debugger websocket", err);
			});

			appDebugSocket.on("error", (err) => {
				this.$logger.trace("Error on debugger deviceSocket", err);
			});

			webSocket.on("message", (message) => {
				const msg = message.toString();
				if (process.env.DEBUG_DEVTOOLS_SOCKETS) {
					console.log({
						msgFromDevtools: JSON.parse(msg),
					});
				}
				const length = Buffer.byteLength(msg, encoding);
				const payload = Buffer.allocUnsafe(length + 4);
				payload.writeInt32BE(length, 0);
				payload.write(msg, 4, length, encoding);
				appDebugSocket.write(payload);
			});

			appDebugSocket.on("close", () => {
				currentAppSocket = null;
				this.$logger.trace("Backend socket closed!");
				webSocket.close();
			});

			webSocket.on("close", async () => {
				currentWebSocket = null;
				this.$logger.trace("Frontend socket closed!");
				appDebugSocket.unpipe(packets);
				packets.destroy();
				await device.destroyDebugSocket(appId);
				if (!this.$options.watch) {
					process.exit(0);
				}
			});

			clientConnectionLockRelease();
			global.frontendWaitingPort = false
		});

		return server;
	}

	public async removeAllProxies() {
		// If there are proxies that are still initialising wait for them to connect first
		const stillInitialising = Object.keys(this.deviceWebServersInitialising);
		if (stillInitialising.length) {
			this.$logger.trace(
				"Waiting for remaining uninitialised device/app web server proxies to finish initialising so they can be closed..."
			);
			const err = Symbol("timeout");
			const result = await Promise.race([
				Promise.all(Object.values(this.deviceWebServersInitialising)),
				sleep(5000).then(() => err),
			]);
			if (result === err) {
				// We don't want to throw here becuase we haven't closed established connections
				this.$logger.warn(
					`Timeout waiting for one or more device debug web server proxies: ${stillInitialising}`
				);
			}
		}

		let deviceId;
		for (deviceId in this.deviceWebServers) {
			this.deviceWebServers[deviceId].close();
		}

		for (deviceId in this.deviceTcpServers) {
			this.deviceTcpServers[deviceId].close();
		}

		this.deviceWebServers = {};
		this.deviceTcpServers = {};
	}
}
injector.register("appDebugSocketProxyFactory", AppDebugSocketProxyFactory);
