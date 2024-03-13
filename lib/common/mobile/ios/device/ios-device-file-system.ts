import { EOL } from "os";
import * as _ from "lodash";
import { IFileSystem, IStringDictionary } from "../../../declarations";
import { spawn } from "child_process"
import path = require("path")

export class IOSDeviceFileSystem implements Mobile.IDeviceFileSystem {
	private static AFC_DELETE_FILE_NOT_FOUND_ERROR = 8;

	constructor(
		private device: Mobile.IDevice,
		private $logger: ILogger,
		private $iosDeviceOperations: IIOSDeviceOperations,
		private $fs: IFileSystem
	) {}

	public async listFiles(
		devicePath: string,
		appIdentifier: string
	): Promise<void> {
		if (!devicePath) {
			devicePath = ".";
		}

		this.$logger.info("Listing %s", devicePath);

		const deviceIdentifier = this.device.deviceInfo.identifier;
		let children: string[] = [];
		const result = await this.$iosDeviceOperations.listDirectory([
			{ deviceId: deviceIdentifier, path: devicePath, appId: appIdentifier },
		]);
		children = result[deviceIdentifier][0].response;
		this.$logger.info(children.join(EOL));
	}

	public async getFile(
		deviceFilePath: string,
		appIdentifier: string,
		outputFilePath?: string
	): Promise<void> {
		if (outputFilePath) {
			await this.$iosDeviceOperations.downloadFiles([
				{
					appId: appIdentifier,
					deviceId: this.device.deviceInfo.identifier,
					source: deviceFilePath,
					destination: outputFilePath,
				},
			]);
			return;
		}

		const fileContent = await this.getFileContent(
			deviceFilePath,
			appIdentifier
		);
		this.$logger.info(fileContent);
	}

	public async getFileContent(
		deviceFilePath: string,
		appIdentifier: string
	): Promise<string> {
		const result = await this.$iosDeviceOperations.readFiles([
			{
				deviceId: this.device.deviceInfo.identifier,
				path: deviceFilePath,
				appId: appIdentifier,
			},
		]);
		const response = result[this.device.deviceInfo.identifier][0];
		return response.response;
	}

	public async putFile(
		localFilePath: string,
		deviceFilePath: string,
		appIdentifier: string
	): Promise<void> {
		await this.uploadFilesCore([
			{
				appId: appIdentifier,
				deviceId: this.device.deviceInfo.identifier,
				files: [{ source: localFilePath, destination: deviceFilePath }],
			},
		]);
	}

	public async deleteFile(
		deviceFilePath: string,
		appIdentifier: string
	): Promise<void> {
		await this.$iosDeviceOperations.deleteFiles(
			[
				{
					appId: appIdentifier,
					destination: deviceFilePath,
					deviceId: this.device.deviceInfo.identifier,
				},
			],
			(err: IOSDeviceLib.IDeviceError) => {
				this.$logger.trace(
					`Error while deleting file: ${deviceFilePath}: ${err.message} with code: ${err.code}`
				);

				if (err.code !== IOSDeviceFileSystem.AFC_DELETE_FILE_NOT_FOUND_ERROR) {
					this.$logger.warn(
						`Cannot delete file: ${deviceFilePath}. Reason: ${err.message}`
					);
				}
			}
		);
	}

	public async transferFiles(
		deviceAppData: Mobile.IDeviceAppData,
		localToDevicePaths: Mobile.ILocalToDevicePathData[]
	): Promise<Mobile.ILocalToDevicePathData[]> {
		const filesToUpload: Mobile.ILocalToDevicePathData[] = _.filter(
			localToDevicePaths,
			(l) => this.$fs.getFsStats(l.getLocalPath()).isFile()
		);
		const files: IOSDeviceLib.IFileData[] = filesToUpload.map((l) => ({
			source: l.getLocalPath(),
			destination: l.getDevicePath(),
		}));
		console.time('transferFiles')
		
		// OPTIMISATION:
		// - Call another method prepareForTransferFiles upon rebuild started, or even upon CLI
		//   launch. This method runs devicectl device copy to ... but is given the path to a named
		//   pipe FIFO file (basically a virtual file on the fs) to read from rather than the path
		//   to the written bundle.js after it has been written. This allows devicectl to get
		//   through all the "Acquired tunnel connection to device." etc. steps that waste time
		//   before it actually copies the file
		// - When THIS method is called, we simply write to the named pipe FIFO file and devicectl
		//   will read it and copy it to the device

		const baseCopyArgs = [
			"devicectl",
			"device",
			"copy",
			"to",
			"--device",
			this.device.deviceInfo.identifier,
			"--user",
			"root",
			"--domain-type",
			"appDataContainer",
			"--domain-identifier",
			"--timeout",
			"5",
			deviceAppData.appIdentifier,
		]

		await Promise.all(files.map(async f => {
			console.log(`Copying ${f.destination}...`)
			return new Promise<void>((res, rej) => {
				const cp = spawn('/usr/bin/xcrun', [
					...baseCopyArgs,
					"--source",
					f.source,
					"--destination",
					f.destination
				])
				cp.on('exit', code => {
					if (code === 0) {
						res()
					} else {
						rej(new Error(`Failed to copy file ${f.source} to ${f.destination} with code ${code}`))
					}
				})
			})
		}))

		// await this.uploadFilesCore([
		// 	{
		// 		deviceId: this.device.deviceInfo.identifier,
		// 		appId: deviceAppData.appIdentifier,
		// 		files: files,
		// 	},
		// ]);
		console.timeEnd('transferFiles')

		return filesToUpload;
	}

	public async transferDirectory(
		deviceAppData: Mobile.IDeviceAppData,
		localToDevicePaths: Mobile.ILocalToDevicePathData[],
		projectFilesPath: string
	): Promise<Mobile.ILocalToDevicePathData[]> {
		await this.transferFiles(deviceAppData, localToDevicePaths);
		return localToDevicePaths;
	}

	public async updateHashesOnDevice(
		hashes: IStringDictionary,
		appIdentifier: string
	): Promise<void> {
		return;
	}

	private async uploadFilesCore(
		filesToUpload: IOSDeviceLib.IUploadFilesData[]
	): Promise<void> {
		await this.$iosDeviceOperations.uploadFiles(
			filesToUpload,
			(err: IOSDeviceLib.IDeviceError) => {
				if (err.deviceId === this.device.deviceInfo.identifier) {
					throw err;
				}
			}
		);
	}
}
