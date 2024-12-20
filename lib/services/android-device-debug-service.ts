import { sleep } from "../common/helpers";
import { DebugServiceBase } from "./debug-service-base";
import { LiveSyncPaths } from "../common/constants";
import { performanceLog } from "../common/decorators";
import {
	IDeviceDebugService,
	IDebugData,
	IDebugOptions,
	IDebugResultInfo,
} from "../definitions/debug";
import { IStaticConfig } from "../declarations";
import { IErrors, INet } from "../common/declarations";
import { ICleanupService } from "../definitions/cleanup-service";
import { injector } from "../common/yok";
import * as _ from "lodash";

export class AndroidDeviceDebugService
	extends DebugServiceBase
	implements IDeviceDebugService {
	private _packageName: string;
	private deviceIdentifier: string;

	public get platform() {
		return "android";
	}

	constructor(
		protected device: Mobile.IAndroidDevice,
		protected $devicesService: Mobile.IDevicesService,
		protected $cleanupService: ICleanupService,
		private $errors: IErrors,
		private $logger: ILogger,
		private $androidProcessService: Mobile.IAndroidProcessService,
		private $staticConfig: IStaticConfig,
		private $net: INet,
		private $deviceLogProvider: Mobile.IDeviceLogProvider
	) {
		super(device, $devicesService);
		this.deviceIdentifier = device.deviceInfo.identifier;
	}

	@performanceLog()
	public async debug(
		debugData: IDebugData,
		debugOptions: IDebugOptions
	): Promise<IDebugResultInfo> {
		this._packageName = debugData.applicationIdentifier;
		const result = await this.debugCore(
			debugData.applicationIdentifier,
			debugOptions
		);

		// TODO: extract this logic outside the debug service
		if (debugOptions.start && !debugOptions.justlaunch) {
			const pid = await this.$androidProcessService.getAppProcessId(
				this.deviceIdentifier,
				debugData.applicationIdentifier
			);
			if (pid) {
				this.$deviceLogProvider.setApplicationPidForDevice(
					this.deviceIdentifier,
					pid
				);
				this.$deviceLogProvider.setProjectDirForDevice(
					this.device.deviceInfo.identifier,
					debugData.projectDir
				);
				const device = await this.$devicesService.getDevice(
					this.deviceIdentifier
				);
				await device.openDeviceLogStream();
			}
		}

		return result;
	}

	public debugStop(): Promise<void> {
		return this.removePortForwarding();
	}

	private async removePortForwarding(packageName?: string): Promise<void> {
		const port = await this.getForwardedDebugPort(
			this.device.deviceInfo.identifier,
			packageName || this._packageName
		);
		return this.device.adb.executeCommand([
			"forward",
			"--remove",
			`tcp:${port}`,
		]);
	}

	// TODO: Remove this method and reuse logic from androidProcessService
	private async getForwardedDebugPort(
		deviceId: string,
		packageName: string
	): Promise<number> {
		let port = -1;
		const forwardsResult = await this.device.adb.executeCommand([
			"forward",
			"--list",
		]);

		const unixSocketName = `${packageName}-inspectorServer`;

		//matches 123a188909e6czzc tcp:40001 localabstract:org.nativescript.testUnixSockets-debug
		const regexp = new RegExp(
			`(?:${deviceId} tcp:)([\\d]+)(?= localabstract:${unixSocketName})`,
			"g"
		);
		const match = regexp.exec(forwardsResult);

		if (match) {
			port = parseInt(match[1]);
		} else {
			port = await this.$net.getAvailablePortInRange(40000);

			await this.unixSocketForward(port, `${unixSocketName}`);
		}

		await this.$cleanupService.addCleanupCommand({
			command: await this.$staticConfig.getAdbFilePath(),
			args: ["-s", deviceId, "forward", "--remove", `tcp:${port}`],
		});

		return port;
	}

	// TODO: Remove this method and reuse logic from androidProcessService
	private async unixSocketForward(
		local: number,
		remote: string
	): Promise<void> {
		await this.device.adb.executeCommand([
			"forward",
			`tcp:${local}`,
			`localabstract:${remote}`,
		]);
	}

	@performanceLog()
	private async debugCore(
		appId: string,
		debugOptions: IDebugOptions
	): Promise<IDebugResultInfo> {
		const result: IDebugResultInfo = { debugUrl: null };
		if (debugOptions.stop) {
			await this.removePortForwarding();
			return result;
		}

		// validateRunningApp uses a stupid method of looking running "cat /proc/net/unix" that
		// returns an empty result even when the app has actually started when called too quickly
		// after the app is launched (even though the cli has just used the adb shell "ps" command
		// to determine that the app is running and get its pid to setup logcat). TODO: verify the
		// app is running by checking for the presence of a global or injected value containing the
		// PID that is collected in order to setup logcat

		await this.validateRunningApp(this.deviceIdentifier, appId);

		if (debugOptions.debugBrk) {
			await this.waitForDebugServer(appId);
		}

		const debugPort = await this.getForwardedDebugPort(
			this.deviceIdentifier,
			appId
		);
		await this.printDebugPort(this.deviceIdentifier, debugPort);

		result.debugUrl = this.getChromeDebugUrl(debugOptions, debugPort);

		return result;
	}

	private async printDebugPort(deviceId: string, port: number): Promise<void> {
		this.$logger.info("device: " + deviceId + " debug port: " + port + "\n");
	}

	// TODO: extract this logic outside the debug service
	/** Note this method not only confirms the app is running (which could be done via 'adb shell
	 * ps') but ensures that the NEW inspector socket is ready for connections. Waiting for this
	 * during an app refresh (nb in debugCore()) when Devtools was already open prevents prematurely
	 * reloading the Devtools window in getChromeDebugUrl in which case it connects to the old web
	 * socket which immediately closes leaving the app launch hanging when --debug-brk is used */
	private async validateRunningApp(
		deviceId: string,
		packageName: string
	): Promise<void> {
		const MAX_TIME_SEC = 2
		let tStart = Date.now()
		while (!(await this.isAppRunning(packageName, deviceId))) {
			if (Date.now() - tStart > MAX_TIME_SEC * 1000)
				this.$errors.fail(
					`The application ${packageName} does not appear to be running on ${deviceId} after ${MAX_TIME_SEC} seconds or is not built with debugging enabled. Try starting the application manually.`
				);
		}
		console.log(`validateRunningApp confirmed app is running in ${Date.now() - tStart} ms`)
	}

	private async waitForDebugServer(appId: String): Promise<void> {
		const debuggerStartedFilePath = `${LiveSyncPaths.ANDROID_TMP_DIR_NAME}/${appId}-debugger-started`;
		const waitText: string = `0 ${debuggerStartedFilePath}`;
		let maxWait = 12;
		let debuggerStarted: boolean = false;
		while (maxWait > 0 && !debuggerStarted) {
			const forwardsResult = await this.device.adb.executeShellCommand([
				"ls",
				"-s",
				debuggerStartedFilePath,
			]);

			maxWait--;

			debuggerStarted = forwardsResult.indexOf(waitText) === -1;

			if (!debuggerStarted) {
				await sleep(500);
			}
		}

		if (debuggerStarted) {
			this.$logger.info("# NativeScript Debugger started #");
		} else {
			this.$logger.warn("# NativeScript Debugger did not start in time #");
		}
	}

	private async isAppRunning(
		appIdentifier: string,
		deviceIdentifier: string
	): Promise<boolean> {
		const debuggableApps = await this.$androidProcessService.getDebuggableApps(
			deviceIdentifier
		);

		return !!_.find(debuggableApps, (a) => a.appIdentifier === appIdentifier);
	}
}

injector.register(
	"androidDeviceDebugService",
	AndroidDeviceDebugService,
	false
);
