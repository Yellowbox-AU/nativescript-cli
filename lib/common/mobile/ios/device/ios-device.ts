import * as applicationManagerPath from "./ios-application-manager";
import * as fileSystemPath from "./ios-device-file-system";
import * as commonConstants from "../../../constants";
import * as constants from "../../../../constants";
import * as net from "net";
import * as _ from "lodash";
import { cache } from "../../../decorators";
import { IOSDeviceBase } from "../ios-device-base";
import { IiOSSocketRequestExecutor } from "../../../../declarations";
import { IErrors } from "../../../declarations";
import { IInjector } from "../../../definitions/yok";
import { injector } from "../../../yok";

export class IOSDevice extends IOSDeviceBase {
	public applicationManager: Mobile.IDeviceApplicationManager;
	public fileSystem: Mobile.IDeviceFileSystem;
	public deviceInfo: Mobile.IDeviceInfo;
	private _deviceLogHandler: (...args: any[]) => void;

	constructor(
		private deviceActionInfo: IOSDeviceLib.IDeviceActionInfo,
		protected $errors: IErrors,
		private $injector: IInjector,
		protected $iOSDebuggerPortService: IIOSDebuggerPortService,
		protected $deviceLogProvider: Mobile.IDeviceLogProvider,
		protected $logger: ILogger,
		protected $lockService: ILockService,
		private $iOSSocketRequestExecutor: IiOSSocketRequestExecutor,
		private $devicePlatformsConstants: Mobile.IDevicePlatformsConstants,
		private $iOSDeviceProductNameMapper: Mobile.IiOSDeviceProductNameMapper,
		private $iosDeviceOperations: IIOSDeviceOperations,
		private $mobileHelper: Mobile.IMobileHelper
	) {
		super();
		this.applicationManager = this.$injector.resolve(
			applicationManagerPath.IOSApplicationManager,
			{ device: this, devicePointer: this.deviceActionInfo }
		);
		this.fileSystem = this.$injector.resolve(
			fileSystemPath.IOSDeviceFileSystem,
			{ device: this, devicePointer: this.deviceActionInfo }
		);
		const productType = deviceActionInfo.productType;
		const isTablet = this.$mobileHelper.isiOSTablet(productType);
		const deviceStatus =
			deviceActionInfo.status || commonConstants.UNREACHABLE_STATUS;
		this.deviceInfo = {
			identifier: deviceActionInfo.deviceId,
			vendor: "Apple",
			platform: this.getPlatform(productType),
			status: deviceStatus,
			errorHelp:
				deviceStatus === commonConstants.UNREACHABLE_STATUS
					? `Device ${deviceActionInfo.deviceId} is ${commonConstants.UNREACHABLE_STATUS}`
					: null,
			type: "Device",
			isTablet: isTablet,
			displayName:
				this.$iOSDeviceProductNameMapper.resolveProductName(
					deviceActionInfo.deviceName
				) || deviceActionInfo.deviceName,
			model: this.$iOSDeviceProductNameMapper.resolveProductName(productType),
			version: deviceActionInfo.productVersion,
			color: deviceActionInfo.deviceColor,
			activeArchitecture: this.getActiveArchitecture(productType),
			connectionTypes: [],
		};

		if (deviceActionInfo.isUSBConnected) {
			this.deviceInfo.connectionTypes.push(constants.DeviceConnectionType.USB);
		}
		if (deviceActionInfo.isWiFiConnected) {
			this.deviceInfo.connectionTypes.push(constants.DeviceConnectionType.Wifi);
		}
	}

	public get isEmulator(): boolean {
		return false;
	}

	public get isOnlyWiFiConnected(): boolean {
		const result = this.deviceInfo.connectionTypes.every(
			(connectionType) => connectionType === constants.DeviceConnectionType.Wifi
		);
		return result;
	}

	@cache()
	public async openDeviceLogStream(): Promise<void> {
		if (this.deviceInfo.status !== commonConstants.UNREACHABLE_STATUS) {
			// Wait for ANY log data to come through, since ios-device-lib doesn't do this or have
			// any other way to confirm logs have started being received. If we dont wait for
			// something here we will launch the app first and miss the "inspector port" message
			// that comes through first.
			const t0 = Date.now()
			const prom = new Promise<void>((resolve, reject) => {
				const timerId = setTimeout(() => reject(new Error("Timeout waiting for device log")), 3000);
				this.$iosDeviceOperations.once(
					commonConstants.DEVICE_LOG_EVENT_NAME,
					() => {
						console.log(`openDeviceLogStream got log data after ${Date.now() - t0}ms`)
						clearTimeout(timerId);
						resolve();
					}
				);
			})

			this.$iosDeviceOperations.on(
				commonConstants.DEVICE_LOG_EVENT_NAME,
				this._deviceLogHandler = this.actionOnDeviceLog.bind(this)
			);

			this.$iosDeviceOperations.startDeviceLog(this.deviceInfo.identifier);
			return prom;
		}
	}

	protected async getDebugSocketCore(appId: string): Promise<net.Socket> {
		console.time('connInspectorSocket')
		const deviceId = this.deviceInfo.identifier;
		const port = global.lastSeenPort || await (async () => {
			await this.$iOSSocketRequestExecutor.executeAttachRequest(this, constants.AWAIT_NOTIFICATION_TIMEOUT_SECONDS, appId);
			console.timeLog('connInspectorSocket', `executeAttachRequest resolved`.green)
			return await super.getDebuggerPort(appId);
		})()
		console.timeLog('connInspectorSocket', `getDebugSocketCore got port = ${port}`)
		
		// [when the app is not launched with --debug-brk]: Even when we've picked up the inspector
		// port and everything the CPU still gets pinned here by the app starting. How long this
		// takes to return will depend entirely on how long it takes the device to get other work
		// out of the way.
		const { port: deviceResponsePort, host: deviceResponseHost } = await this.$iosDeviceOperations.connectToPort([
			{ deviceId: deviceId, port: port },
		]).then(arr => arr[deviceId][0])
		
		console.timeLog('connInspectorSocket', `getDebugSocketCore got result from connectToPort =`, global.lastSeenPort)

		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`getDebugSocketCore: Timeout connecting to port ${deviceResponsePort}`)), 3000)
			new net.Socket().connect(deviceResponsePort, deviceResponseHost, function () {
				this.removeListener("error", reject);
				clearTimeout(timer)
				console.log(`getDebugSocketCore resolving`.green)
				console.timeEnd('connInspectorSocket')
				resolve(this)
			})
		})
	}

	private actionOnDeviceLog(response: IOSDeviceLib.IDeviceLogData): void {
		if (response.deviceId === this.deviceInfo.identifier) {
			this.$deviceLogProvider.logData(
				response.message,
				this.$devicePlatformsConstants.iOS,
				this.deviceInfo.identifier
			);
		}
	}

	public detach(): void {
		if (this._deviceLogHandler) {
			this.$iosDeviceOperations.removeListener(
				commonConstants.DEVICE_LOG_EVENT_NAME,
				this._deviceLogHandler
			);
		}
	}

	private getActiveArchitecture(productType: string): string {
		let activeArchitecture = "";
		if (productType) {
			productType = productType.toLowerCase().trim();
			const majorVersionAsString = productType.match(/.*?(\d+)\,(\d+)/)[1];
			const majorVersion = parseInt(majorVersionAsString);
			let isArm64Architecture = false;
			//https://en.wikipedia.org/wiki/List_of_iOS_devices
			if (_.startsWith(productType, "iphone")) {
				isArm64Architecture = majorVersion >= 6;
			} else if (_.startsWith(productType, "ipad")) {
				isArm64Architecture = majorVersion >= 4;
			} else if (_.startsWith(productType, "ipod")) {
				isArm64Architecture = majorVersion >= 7;
			} else if (_.startsWith(productType, "realitydevice")) {
				// visionos
				isArm64Architecture = true;
			}

			activeArchitecture = isArm64Architecture ? "arm64" : "armv7";
		}

		return activeArchitecture;
	}

	private getPlatform(productType: string): string {
		productType = productType.toLowerCase().trim();
		if (_.startsWith(productType, "realitydevice")) {
			// visionos
			return this.$devicePlatformsConstants.visionOS;
		}
		return this.$devicePlatformsConstants.iOS;
	}
}

injector.register("iOSDevice", IOSDevice);
