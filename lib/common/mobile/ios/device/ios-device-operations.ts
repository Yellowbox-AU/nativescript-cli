import { IOSDeviceLib as IOSDeviceLibModule } from "ios-device-lib";
import { cache } from "../../../decorators";
import { CONNECTED_STATUS, DEVICE_LOG_EVENT_NAME } from "../../../constants";
import * as _ from "lodash";
import * as assert from "assert";
import { EventEmitter } from "events";
import {
	IDisposable,
	IShouldDispose,
	IDictionary,
} from "../../../declarations";
import { injector } from "../../../yok";
import { exec, execSync } from "child_process"

export class IOSDeviceOperations
	extends EventEmitter
	implements IIOSDeviceOperations, IDisposable, IShouldDispose {
	public isInitialized: boolean;
	public shouldDispose: boolean;
	private deviceLib: IOSDeviceLib.IOSDeviceLib;

	constructor(private $logger: ILogger) {
		super();

		this.isInitialized = false;
		this.shouldDispose = true;
	}

	public async install(
		ipaPath: string,
		deviceIdentifiers: string[],
		errorHandler: DeviceOperationErrorHandler
	): Promise<IOSDeviceResponse> {
		this.assertIsInitialized();
		this.$logger.trace(
			`Installing ${ipaPath} on devices with identifiers: ${deviceIdentifiers}.`
		);
		return await this.getMultipleResults<IOSDeviceLib.IDeviceResponse>(
			() => this.deviceLib.install(ipaPath, deviceIdentifiers),
			errorHandler
		);
	}

	public async uninstall(
		appIdentifier: string,
		deviceIdentifiers: string[],
		errorHandler: DeviceOperationErrorHandler
	): Promise<IOSDeviceResponse> {
		this.assertIsInitialized();
		this.$logger.trace(
			`Uninstalling ${appIdentifier} from devices with identifiers: ${deviceIdentifiers}.`
		);
		return await this.getMultipleResults<IOSDeviceLib.IDeviceResponse>(
			() => this.deviceLib.uninstall(appIdentifier, deviceIdentifiers),
			errorHandler
		);
	}

	@cache()
	public async startLookingForDevices(
		deviceFoundCallback: DeviceInfoCallback,
		deviceUpdatedCallback: DeviceInfoCallback,
		deviceLostCallback: DeviceInfoCallback,
		options?: Mobile.IDeviceLookingOptions
	): Promise<void> {
		this.$logger.trace("Starting to look for iOS devices.");
		this.isInitialized = true;
		if (!this.deviceLib) {
			let foundDevice = false;
			const wrappedDeviceFoundCallback = (
				deviceInfo: IOSDeviceLib.IDeviceActionInfo
			) => {
				foundDevice = true;

				return deviceFoundCallback(deviceInfo);
			};

			this.deviceLib = new IOSDeviceLibModule(
				wrappedDeviceFoundCallback,
				deviceUpdatedCallback,
				deviceLostCallback
			);
			if (options && options.shouldReturnImmediateResult) {
				return;
			}

			// The below approach using xcrun devicectl list DOESN'T work because as soon as
			// ios-device-lib is notified of a new device it tries to startReadingData, gets nothing
			// and then immediately raises a DeviceLost event, so when the "discover devices"
			// process is finished and we go to start deploying on the device we get an error that
			// no such device could be found

			// const results = JSON.parse(execSync(`xcrun devicectl list devices -j - --quiet`).toString()).result.devices as {
			// 	capabilities: any,
			// 	connectionProperties: {
			// 		transportType: 'localNetwork' | 'wired'
			// 	} & Record<string, any>,
			// 	deviceProperties: {
			// 		/** E.g. "ben-iphone-14" */
			// 		name: string
			// 		/** E.g. "21A351" */
			// 		osBuildUpdate: string
			// 		/** E.g. "17.0.2" */
			// 		osVersionNumber: string
			// 	} & Record<string, any>,
			// 	hardwareProperties: {
			// 		cpuType: any,
			// 		/** E.g. "iPhone" */
			// 		deviceType: string
			// 		/** E.g. "D73AP" */
			// 		hardwareModel: string
			// 		/** E.g. "iPhone 14 Pro" */
			// 		marketingName: string
			// 		/** E.g. "iOS" */
			// 		platform: string
			// 		/** E.g. "iPhone15,2" */
			// 		productType: string
			// 		/** E.g. "physical" */
			// 		reality: string
			// 		/** E.g. "F75JQD7956" */
			// 		serialNumber: string,
			// 		/** E.g. "00008120-001471302EEB401E" */
			// 		udid: string
			// 	} & Record<string, any>,
			// 	/** E.g. "013916C7-815D-467D-B6E7-034C7D8DE614" */
			// 	identifier: string
			// }[]
			// console.log(`Found ${results.length} devices:`)
			// console.table(results.map(r => ({
			// 	name: r.deviceProperties.name,
			// 	identifier: r.identifier,
			// 	// udid: r.hardwareProperties.udid,
			// 	// productType: r.hardwareProperties.productType,
			// 	marketingName: r.hardwareProperties.marketingName,
			// 	// deviceType: r.hardwareProperties.deviceType,
			// 	OS: r.deviceProperties.osVersionNumber,
			// 	connection: r.connectionProperties.transportType === 'wired' ? 'USB' : 'WiFi'
			// })))
			// for (const result of results) {
			// 	deviceFoundCallback({
			// 		deviceId: result.identifier,
			// 		event: 'add',
			// 		deviceName: result.hardwareProperties.marketingName,
			// 		productType: result.hardwareProperties.deviceType,
			// 		productVersion: result.hardwareProperties.productType,
			// 		status: CONNECTED_STATUS,
			// 		isUSBConnected: result.connectionProperties.transportType === 'wired' ? 1 : 0,
			// 		isWiFiConnected: result.connectionProperties.transportType === 'localNetwork' ? 1 : 0
			// 	})
			// }


			// We need this because we need to make sure that we have devices.
			await new Promise<void>((resolve, reject) => {
				const tStart = Date.now()

				const intervalHandle: NodeJS.Timer = setInterval(() => {
					if (foundDevice && !options.fullDiscovery) {
						resolve();
						return clearInterval(intervalHandle);
					}

					if (Date.now() - tStart >= 10000) {
						console.warn(`startLookingForDevices did not find device after 10 seconds`)
						clearInterval(intervalHandle);
						return resolve();
					}
				}, 2000);
			});
		}
	}

	public startDeviceLog(deviceIdentifier: string): void {
		this.assertIsInitialized();
		this.setShouldDispose(false);

		this.$logger.trace(
			`Printing device log for device with identifier: ${deviceIdentifier}.`
		);

		this.attacheDeviceLogDataHandler();

		this.deviceLib.startDeviceLog([deviceIdentifier]);
	}

	public async apps(
		deviceIdentifiers: string[],
		errorHandler?: DeviceOperationErrorHandler
	): Promise<IOSDeviceAppInfo> {
		this.assertIsInitialized();
		this.$logger.trace(
			`Getting applications information for devices with identifiers: ${deviceIdentifiers}`
		);
		return this.getMultipleResults(
			() => this.deviceLib.apps(deviceIdentifiers),
			errorHandler
		);
	}

	public async listDirectory(
		listArray: IOSDeviceLib.IReadOperationData[],
		errorHandler?: DeviceOperationErrorHandler
	): Promise<IOSDeviceMultipleResponse> {
		this.assertIsInitialized();

		_.each(listArray, (l) => {
			this.$logger.trace(
				`Listing directory: ${l.path} for application ${l.appId} on device with identifier: ${l.deviceId}.`
			);
		});

		return this.getMultipleResults<IOSDeviceLib.IDeviceMultipleResponse>(
			() => this.deviceLib.list(listArray),
			errorHandler
		);
	}

	public async readFiles(
		deviceFilePaths: IOSDeviceLib.IReadOperationData[],
		errorHandler?: DeviceOperationErrorHandler
	): Promise<IOSDeviceResponse> {
		this.assertIsInitialized();

		_.each(deviceFilePaths, (p) => {
			this.$logger.trace(
				`Reading file: ${p.path} from application ${p.appId} on device with identifier: ${p.deviceId}.`
			);
		});

		return this.getMultipleResults<IOSDeviceLib.IDeviceResponse>(
			() => this.deviceLib.read(deviceFilePaths),
			errorHandler
		);
	}

	public async downloadFiles(
		deviceFilePaths: IOSDeviceLib.IFileOperationData[],
		errorHandler?: DeviceOperationErrorHandler
	): Promise<IOSDeviceResponse> {
		this.assertIsInitialized();

		_.each(deviceFilePaths, (d) => {
			this.$logger.trace(
				`Downloading file: ${d.source} from application ${d.appId} on device with identifier: ${d.deviceId} to ${d.destination}.`
			);
		});

		return this.getMultipleResults<IOSDeviceLib.IDeviceResponse>(
			() => this.deviceLib.download(deviceFilePaths),
			errorHandler
		);
	}

	public uploadFiles(
		files: IOSDeviceLib.IUploadFilesData[],
		errorHandler?: DeviceOperationErrorHandler
	): Promise<IOSDeviceResponse> {
		this.assertIsInitialized();

		_.each(files, (f) => {
			this.$logger.trace("Uploading files:");
			this.$logger.trace(f.files);
			this.$logger.trace(
				`For application ${f.appId} on device with identifier: ${f.deviceId}.`
			);
		});

		return this.getMultipleResults<IOSDeviceLib.IDeviceResponse>(
			() => this.deviceLib.upload(files),
			errorHandler
		);
	}

	public async deleteFiles(
		deleteArray: IOSDeviceLib.IDeleteFileData[],
		errorHandler?: DeviceOperationErrorHandler
	): Promise<IOSDeviceResponse> {
		this.assertIsInitialized();

		_.each(deleteArray, (d) => {
			this.$logger.trace(
				`Deleting file: ${d.destination} from application ${d.appId} on device with identifier: ${d.deviceId}.`
			);
		});

		return this.getMultipleResults<IOSDeviceLib.IDeviceResponse>(
			() => this.deviceLib.delete(deleteArray),
			errorHandler
		);
	}

	public async start(
		startArray: IOSDeviceLib.IDdiApplicationData[],
		errorHandler?: DeviceOperationErrorHandler
	): Promise<IOSDeviceResponse> {
		this.assertIsInitialized();

		_.each(startArray, (s) => {
			this.$logger.trace(
				`Starting application ${s.appId} on device with identifier: ${s.deviceId}.`
			);
		});
		const [job] = startArray
		// --start-stopped should be conditional on the waitForDebugger flag. Without it we miss the
		// initial console outputs including the one which triggers devtools line output
		exec(`xcrun devicectl device process launch --device ${job.deviceId} --terminate-existing ${job.appId} waitForDebugger`) //  --start-stopped
		return
		// this.getMultipleResults<IOSDeviceLib.IDeviceResponse>(
		// 	() => this.deviceLib.start(startArray),
		// 	errorHandler
		// );
	}

	public async stop(
		stopArray: IOSDeviceLib.IDdiApplicationData[],
		errorHandler?: DeviceOperationErrorHandler
	): Promise<IOSDeviceResponse> {
		this.assertIsInitialized();

		_.each(stopArray, (s) => {
			this.$logger.trace(
				`Stopping application ${s.appId} on device with identifier: ${s.deviceId}.`
			);
		});

		return undefined as any // No need to stop on iOS17+, we use terminate-existing flag when starting

		// // Get process ID -     std::string command = "xcrun devicectl device info processes --device " + device_identifier + " --filter \"executable.path == '"+ executable + "'\"";
		// const [job] = stopArray
		// // Get info for all processes by capturing json output
		// const processInfo = JSON.parse(execSync(`xcrun devicectl device info processes --device ${job.deviceId} -j - --quiet`).toString()) as {
		// 	info: any,
		// 	result: {
		// 		deviceIdentifier: "013916C7-815D-467D-B6E7-034C7D8DE614",
		// 		runningProcesses: {
		// 			/** E.g. "file:///private/var/containers/Bundle/Application/13DDA128-D657-43D1-A3D8-7D010380AD3B/Yellowbox.app/Yellowbox" */
		// 			executable: string,
		// 			processIdentifier: number
		// 		}[]
		// 	}
		// }

		// const appProcess = processInfo.result.runningProcesses.find(p => p.executable.includes(job.appId))

		// return this.getMultipleResults<IOSDeviceLib.IDeviceResponse>(
		// 	() => this.deviceLib.stop(stopArray),
		// 	errorHandler
		// );
	}

	public dispose(signal?: string): void {
		// We need to check if we should dispose the device lib.
		// For example we do not want to dispose it when we start printing the device logs.
		if (this.shouldDispose && this.deviceLib) {
			this.deviceLib.removeAllListeners();
			this.deviceLib.dispose(signal);
			this.deviceLib = null;
			this.$logger.trace("IOSDeviceOperations disposed.");
		}
	}

	public async postNotification(
		postNotificationArray: IOSDeviceLib.IPostNotificationData[],
		errorHandler?: DeviceOperationErrorHandler
	): Promise<IOSDeviceResponse> {
		this.assertIsInitialized();

		_.each(postNotificationArray, (n) => {
			this.$logger.trace(
				`Sending notification ${n.notificationName} to device with identifier: ${n.deviceId}`
			);
		});

		return this.getMultipleResults<IOSDeviceLib.IDeviceResponse>(
			() => this.deviceLib.postNotification(postNotificationArray),
			errorHandler
		);
	}

	public async awaitNotificationResponse(
		awaitNotificationResponseArray: IOSDeviceLib.IAwaitNotificatioNResponseData[],
		errorHandler?: DeviceOperationErrorHandler
	): Promise<IOSDeviceResponse> {
		this.assertIsInitialized();

		_.each(awaitNotificationResponseArray, (n) => {
			this.$logger.trace(
				`Awaiting notification response from socket: ${n.socket} with timeout: ${n.timeout}`
			);
		});

		return this.getMultipleResults<IOSDeviceLib.IDeviceResponse>(
			() =>
				this.deviceLib.awaitNotificationResponse(
					awaitNotificationResponseArray
				),
			errorHandler
		);
	}

	public async connectToPort(
		connectToPortArray: IOSDeviceLib.IConnectToPortData[],
		errorHandler?: DeviceOperationErrorHandler
	): Promise<IDictionary<IOSDeviceLib.IConnectToPortResponse[]>> {
		this.assertIsInitialized();

		_.each(connectToPortArray, (c) => {
			this.$logger.trace(
				`Connecting to port ${c.port} on device with identifier: ${c.deviceId}`
			);
		});

		return this.getMultipleResults<IOSDeviceLib.IConnectToPortResponse>(
			() => this.deviceLib.connectToPort(connectToPortArray),
			errorHandler
		);
	}

	public setShouldDispose(shouldDispose: boolean): void {
		this.shouldDispose = shouldDispose;
	}

	private async getMultipleResults<T>(
		getPromisesMethod: () => Promise<T>[],
		errorHandler?: DeviceOperationErrorHandler
	): Promise<IDictionary<T[]>> {
		const result: T[] = [];
		const promises = getPromisesMethod();

		for (const promise of promises) {
			if (errorHandler) {
				try {
					result.push(await promise);
				} catch (err) {
					this.$logger.trace(
						`Error while executing ios device operation: ${err.message} with code: ${err.code}`
					);
					errorHandler(err);
				}
			} else {
				result.push(await promise);
			}
		}

		const groupedResults = _.groupBy(result, (r) => <string>(<any>r).deviceId);
		this.$logger.trace("Received multiple results:");
		this.$logger.trace(groupedResults);

		return groupedResults;
	}

	private assertIsInitialized(): void {
		assert.ok(this.isInitialized, "iOS device operations not initialized.");
	}

	@cache()
	private attacheDeviceLogDataHandler(): void {
		this.deviceLib.on(
			DEVICE_LOG_EVENT_NAME,
			(response: IOSDeviceLib.IDeviceLogData) => {
				this.emit(DEVICE_LOG_EVENT_NAME, response);
			}
		);
	}
}

injector.register("iosDeviceOperations", IOSDeviceOperations);
