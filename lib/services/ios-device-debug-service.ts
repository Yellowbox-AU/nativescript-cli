import * as path from "path";
import { ChildProcess } from "child_process";
import { DebugServiceBase } from "./debug-service-base";
import {
	CONNECTION_ERROR_EVENT_NAME,
	// DeviceConnectionType,
} from "../constants";
const inspectorAppName = "NativeScript Inspector.app";
const inspectorNpmPackageName = "tns-ios-inspector";
const inspectorUiDir = "WebInspectorUI/";
import { performanceLog } from "../common/decorators";
import { platform } from "os";
import {
	IDeviceDebugService,
	IDebugOptions,
	IDebugResultInfo,
	IDebugData,
} from "../definitions/debug";
import {
	IPackageInstallationManager,
	IAppDebugSocketProxyFactory,
} from "../declarations";
import { IProjectDataService } from "../definitions/project";
import { IChildProcess, IHostInfo, IErrors } from "../common/declarations";
import { injector } from "../common/yok";

export class IOSDeviceDebugService
	extends DebugServiceBase
	implements IDeviceDebugService {
	private deviceIdentifier: string;

	constructor(
		protected device: Mobile.IiOSDevice,
		protected $devicesService: Mobile.IDevicesService,
		private $childProcess: IChildProcess,
		private $hostInfo: IHostInfo,
		private $logger: ILogger,
		private $errors: IErrors,
		private $packageInstallationManager: IPackageInstallationManager,
		private $appDebugSocketProxyFactory: IAppDebugSocketProxyFactory,
		private $projectDataService: IProjectDataService
	) {
		super(device, $devicesService);
		this.$appDebugSocketProxyFactory.on(
			CONNECTION_ERROR_EVENT_NAME,
			(e: Error) => this.emit(CONNECTION_ERROR_EVENT_NAME, e)
		);
		this.deviceIdentifier = this.device.deviceInfo.identifier;
	}

	public get platform(): string {
		return "ios";
	}

	@performanceLog()
	public async debug(
		debugData: IDebugData,
		debugOptions: IDebugOptions
	): Promise<IDebugResultInfo> {
		await this.validateOptions(debugOptions);
		const result: IDebugResultInfo = { debugUrl: null };

		result.debugUrl = await this.wireDebuggerClient(debugData, debugOptions);

		return result;
	}

	public async debugStop(): Promise<void> {
		await this.$appDebugSocketProxyFactory.removeAllProxies();
	}

	private async validateOptions(debugOptions: IDebugOptions) {
		if (!this.$hostInfo.isWindows && !this.$hostInfo.isDarwin) {
			this.$errors.fail(
				`Debugging on iOS devices is not supported for ${platform()} yet.`
			);
		}

		if (debugOptions.debugBrk && debugOptions.start) {
			this.$errors.fail(
				"Expected exactly one of the --debug-brk or --start options."
			);
		}

		// await this.validateUSBConnectedDevice(); // NOT ANYMORE BITCH
	}

	// private async validateUSBConnectedDevice() {
	// 	const device = await this.$devicesService.getDevice(this.deviceIdentifier);
	// 	if (
	// 		device.deviceInfo.connectionTypes.indexOf(DeviceConnectionType.USB) ===
	// 			-1 &&
	// 		device.deviceInfo.connectionTypes.indexOf(DeviceConnectionType.Local) ===
	// 			-1
	// 	) {
	// 		const deviceConnectionTypes = device.deviceInfo.connectionTypes
	// 			.map((type) => DeviceConnectionType[type])
	// 			.join(", ");
	// 		this.$errors.fail(
	// 			`Debugging application requires a USB or LOCAL connection while the target device "${this.deviceIdentifier}" has connection type "${deviceConnectionTypes}".`
	// 		);
	// 	}
	// }

	private getProjectName(debugData: IDebugData): string {
		let projectName = debugData.projectName;
		if (!projectName && debugData.projectDir) {
			const projectData = this.$projectDataService.getProjectData(
				debugData.projectDir
			);
			projectName = projectData.projectName;
		}

		return projectName;
	}

	private async killProcess(childProcess: ChildProcess): Promise<void> {
		if (childProcess) {
			return new Promise<void>((resolve, reject) => {
				childProcess.on("close", resolve);
				childProcess.kill();
			});
		}
	}

	@performanceLog()
	private async wireDebuggerClient(
		debugData: IDebugData,
		debugOptions: IDebugOptions
	): Promise<string> {
		if (
			(debugOptions.inspector || !debugOptions.client) &&
			this.$hostInfo.isDarwin
		) {
			return await this.setupTcpAppDebugProxy(debugData, debugOptions);
		} else {
			return await this.setupWebAppDebugProxy(debugOptions, debugData);
		}
	}

	private async setupWebAppDebugProxy(
		debugOptions: IDebugOptions,
		debugData: IDebugData
	): Promise<string> {
		if (debugOptions.chrome) {
			this.$logger.info(
				"'--chrome' is the default behavior. Use --inspector to debug iOS applications using the Safari Web Inspector."
			);
		}
		const projectName = this.getProjectName(debugData);
		// Create the web socket server for the frontend Chrome DevTools window to connect to
		// (usually port 41000), which will proxy through messages to/from the v8-inspector
		// (InspectorServer.mm) server running on the device. The device sends messages back to the
		// cli via ios-device-lib, which uses USBMuxConnectByPort to mux the TCP data over the USB
		// connection somehow. There are actually 2 proxy servers involved to get everything
		// working. One run by ios-device-lib's C++ native layer and the second here in Node JS -
		// not sure why we couldn't just have the ios-device-lib C++ one (android?) or even just
		// have the devtools frontend connect directly to the ios device over the network (NS devs
		// didn't want to force/assume we could always be on the same LAN as the device or it was
		// going to be tricky to obtain the hostname/IP??)
		const webSocketProxy = await this.$appDebugSocketProxyFactory.ensureWebSocketProxy(
			this.device,
			debugData.applicationIdentifier,
			projectName,
			debugData.projectDir
		);

		return this.getChromeDebugUrl(debugOptions, webSocketProxy.options.port);
	}

	private async setupTcpAppDebugProxy(
		debugData: IDebugData,
		debugOptions: IDebugOptions
	): Promise<string> {
		const projectName = this.getProjectName(debugData);
		const existingTcpProxy = this.$appDebugSocketProxyFactory.getTCPSocketProxy(
			this.deviceIdentifier,
			debugData.applicationIdentifier
		);
		const tcpSocketProxy =
			existingTcpProxy ||
			(await this.$appDebugSocketProxyFactory.addTCPSocketProxy(
				this.device,
				debugData.applicationIdentifier,
				projectName,
				debugData.projectDir
			));
		if (!existingTcpProxy) {
			const inspectorProcess = await this.openAppInspector(
				tcpSocketProxy.address(),
				debugData,
				debugOptions
			);
			if (inspectorProcess) {
				tcpSocketProxy.on("close", async () => {
					await this.killProcess(inspectorProcess);
				});
			}
		}

		return null;
	}

	@performanceLog()
	private async openAppInspector(
		fileDescriptor: string,
		debugData: IDebugData,
		debugOptions: IDebugOptions
	): Promise<ChildProcess> {
		if (debugOptions.client) {
			const inspectorPath = await this.$packageInstallationManager.getInspectorFromCache(
				inspectorNpmPackageName,
				debugData.projectDir
			);

			const inspectorSourceLocation = path.join(
				inspectorPath,
				inspectorUiDir,
				"Main.html"
			);
			const inspectorApplicationPath = path.join(
				inspectorPath,
				inspectorAppName,
				"Contents",
				"MacOS",
				inspectorAppName,
				"Contents",
				"MacOS",
				"NativeScript Inspector"
			);

			const inspectorProcess: ChildProcess = this.$childProcess.spawn(
				inspectorApplicationPath,
				[inspectorSourceLocation, debugData.projectName, fileDescriptor]
			);
			inspectorProcess.on("error", (e: Error) => this.$logger.trace(e));
			return inspectorProcess;
		} else {
			this.$logger.info("Suppressing debugging client.");
			return null;
		}
	}
}

injector.register("iOSDeviceDebugService", IOSDeviceDebugService, false);
