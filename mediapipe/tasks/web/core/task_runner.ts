/**
 * Copyright 2022 The MediaPipe Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {InferenceCalculatorOptions} from '../../../calculators/tensor/inference_calculator_pb';
import {Acceleration} from '../../../tasks/cc/core/proto/acceleration_pb';
import {BaseOptions as BaseOptionsProto} from '../../../tasks/cc/core/proto/base_options_pb';
import {ExternalFile} from '../../../tasks/cc/core/proto/external_file_pb';
import {BaseOptions, TaskRunnerOptions} from '../../../tasks/web/core/task_runner_options';
import {createMediaPipeLib, FileLocator, GraphRunner, WasmMediaPipeConstructor} from '../../../web/graph_runner/graph_runner';
import {SupportModelResourcesGraphService} from '../../../web/graph_runner/register_model_resources_graph_service';

import {WasmFileset} from './wasm_fileset';

// None of the MP Tasks ship bundle assets.
const NO_ASSETS = undefined;

// tslint:disable-next-line:enforce-name-casing
const CachedGraphRunnerType = SupportModelResourcesGraphService(GraphRunner);
/**
 * An implementation of the GraphRunner that exposes the resource graph
 * service.
 */
export class CachedGraphRunner extends CachedGraphRunnerType {}

/**
 * Creates a new instance of a Mediapipe Task. Determines if SIMD is
 * supported and loads the relevant WASM binary.
 * @return A fully instantiated instance of `T`.
 */
export async function createTaskRunner<T extends TaskRunner>(
    type: WasmMediaPipeConstructor<T>, initializeCanvas: boolean,
    fileset: WasmFileset, options: TaskRunnerOptions): Promise<T> {
  const fileLocator: FileLocator = {
    locateFile() {
      // The only file loaded with this mechanism is the Wasm binary
      return fileset.wasmBinaryPath.toString();
    }
  };

  // Initialize a canvas if requested. If OffscreenCanvas is available, we
  // let the graph runner initialize it by passing `undefined`.
  const canvas = initializeCanvas ? (typeof OffscreenCanvas === 'undefined' ?
                                         document.createElement('canvas') :
                                         undefined) :
                                    null;
  const instance = await createMediaPipeLib(
      type, fileset.wasmLoaderPath, NO_ASSETS, canvas, fileLocator);
  await instance.setOptions(options);
  return instance;
}

/** Base class for all MediaPipe Tasks. */
export abstract class TaskRunner {
  protected abstract baseOptions: BaseOptionsProto;
  private processingErrors: Error[] = [];
  private latestOutputTimestamp = 0;

  /**
   * Creates a new instance of a Mediapipe Task. Determines if SIMD is
   * supported and loads the relevant WASM binary.
   * @return A fully instantiated instance of `T`.
   */
  protected static async createInstance<T extends TaskRunner>(
      type: WasmMediaPipeConstructor<T>, initializeCanvas: boolean,
      fileset: WasmFileset, options: TaskRunnerOptions): Promise<T> {
    return createTaskRunner(type, initializeCanvas, fileset, options);
  }

  /** @hideconstructor protected */
  constructor(protected readonly graphRunner: CachedGraphRunner) {
    // Disables the automatic render-to-screen code, which allows for pure
    // CPU processing.
    this.graphRunner.setAutoRenderToScreen(false);
  }

  /** Configures the task with custom options. */
  abstract setOptions(options: TaskRunnerOptions): Promise<void>;

  /**
   * Applies the current set of options, including any base options that have
   * not been processed by the task implementation. The options are applied
   * synchronously unless a `modelAssetPath` is provided. This ensures that
   * for most use cases options are applied directly and immediately affect
   * the next inference.
   */
  protected applyOptions(options: TaskRunnerOptions): Promise<void> {
    const baseOptions: BaseOptions = options.baseOptions || {};

    // Validate that exactly one model is configured
    if (options.baseOptions?.modelAssetBuffer &&
        options.baseOptions?.modelAssetPath) {
      throw new Error(
          'Cannot set both baseOptions.modelAssetPath and baseOptions.modelAssetBuffer');
    } else if (!(this.baseOptions.getModelAsset()?.hasFileContent() ||
                 options.baseOptions?.modelAssetBuffer ||
                 options.baseOptions?.modelAssetPath)) {
      throw new Error(
          'Either baseOptions.modelAssetPath or baseOptions.modelAssetBuffer must be set');
    }

    this.setAcceleration(baseOptions);
    if (baseOptions.modelAssetPath) {
      // We don't use `await` here since we want to apply most settings
      // synchronously.
      return fetch(baseOptions.modelAssetPath.toString())
          .then(response => response.arrayBuffer())
          .then(buffer => {
            this.setExternalFile(new Uint8Array(buffer));
            this.refreshGraph();
          });
    } else {
      // Apply the setting synchronously.
      this.setExternalFile(baseOptions.modelAssetBuffer);
      this.refreshGraph();
      return Promise.resolve();
    }
  }

  /** Appliest the current options to the MediaPipe graph. */
  protected abstract refreshGraph(): void;

  /**
   * Takes the raw data from a MediaPipe graph, and passes it to C++ to be run
   * over the video stream. Will replace the previously running MediaPipe graph,
   * if there is one.
   * @param graphData The raw MediaPipe graph data, either in binary
   *     protobuffer format (.binarypb), or else in raw text format (.pbtxt or
   *     .textproto).
   * @param isBinary This should be set to true if the graph is in
   *     binary format, and false if it is in human-readable text format.
   */
  protected setGraph(graphData: Uint8Array, isBinary: boolean): void {
    this.graphRunner.attachErrorListener((code, message) => {
      this.processingErrors.push(new Error(message));
    });

    // Enables use of our model resource caching graph service; we apply this to
    // every MediaPipe graph we run.
    this.graphRunner.registerModelResourcesGraphService();

    this.graphRunner.setGraph(graphData, isBinary);
    this.handleErrors();
  }

  /**
   * Forces all queued-up packets to be pushed through the MediaPipe graph as
   * far as possible, performing all processing until no more processing can be
   * done.
   */
  protected finishProcessing(): void {
    this.graphRunner.finishProcessing();
    this.handleErrors();
  }

  /*
   * Sets the latest output timestamp received from the graph (in ms).
   * Timestamps that are smaller than the currently latest output timestamp are
   * ignored.
   */
  protected setLatestOutputTimestamp(timestamp: number): void {
    this.latestOutputTimestamp =
        Math.max(this.latestOutputTimestamp, timestamp);
  }

  /**
   * Gets a syncthethic timestamp in ms that can be used to send data to the
   * next packet. The timestamp is one millisecond past the last timestamp
   * received from the graph.
   */
  protected getSynctheticTimestamp(): number {
    return this.latestOutputTimestamp + 1;
  }

  /** Throws the error from the error listener if an error was raised. */
  private handleErrors() {
    try {
      const errorCount = this.processingErrors.length;
      if (errorCount === 1) {
        // Re-throw error to get a more meaningful stacktrace
        throw new Error(this.processingErrors[0].message);
      } else if (errorCount > 1) {
        throw new Error(
            'Encountered multiple errors: ' +
            this.processingErrors.map(e => e.message).join(', '));
      }
    } finally {
      this.processingErrors = [];
    }
  }

  /** Configures the `externalFile` option */
  private setExternalFile(modelAssetBuffer?: Uint8Array): void {
    const externalFile = this.baseOptions.getModelAsset() || new ExternalFile();
    if (modelAssetBuffer) {
      externalFile.setFileContent(modelAssetBuffer);
    }
    this.baseOptions.setModelAsset(externalFile);
  }

  /** Configures the `acceleration` option. */
  private setAcceleration(options: BaseOptions) {
    let acceleration = this.baseOptions.getAcceleration();

    if (!acceleration) {
      // Create default instance for the initial configuration.
      acceleration = new Acceleration();
      acceleration.setTflite(new InferenceCalculatorOptions.Delegate.TfLite());
    }

    if ('delegate' in options) {
      if (options.delegate === 'GPU') {
        acceleration.setGpu(new InferenceCalculatorOptions.Delegate.Gpu());
      } else {
        acceleration.setTflite(
            new InferenceCalculatorOptions.Delegate.TfLite());
      }
    }

    this.baseOptions.setAcceleration(acceleration);
  }
}


