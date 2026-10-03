// ============================================================================
//  合成夹具：只用于验证 lib/gen-patch.mjs 的注入点识别、结构自检与语法门禁。
//  这里刻意复刻宿主 worker-task-pool 的派发点**结构指纹**（7 行块），
//  但它是本仓库自造的代码，不是任何真实发行包文件。
// ============================================================================
import { performance } from "node:perf_hooks";

var WorkerTaskError = class extends Error {
  constructor(message, kind) {
    super(message);
    this.name = "WorkerTaskError";
    this.kind = kind;
  }
};

const markWorkerRetirement = () => {};

class FixturePool {
  constructor() {
    this.ownedSettlement = null;
    this.options = { restartOnError: true };
  }

  fail(slot, error) {
    slot.lastError = error;
  }

  start(slot, task, input) {
    const worker = slot.worker;
    const transferList = task.options.transferList?.(input);
    if (!task.done) {
      const transferStartedAt = performance.now();
      worker.postMessage({
        input,
        taskId: task.id,
        interactive: Boolean(task.options.onRequest),
        nativeSections: slot.nativeSections.buffer,
        sampleMemory: true
      }, transferList);
      task.transferMs += performance.now() - transferStartedAt;
    }
    return transferList;
  }

  // 另一处 postMessage（资源回收路径）：指纹必须把它排除在外。
  closeResource(worker, key, port2) {
    try {
      worker.postMessage({
        closeResource: true,
        key,
        resourcePort: port2
      }, [port2]);
    } catch (error) {
      markWorkerRetirement(worker, "failure");
      throw error;
    }
  }
}

export { FixturePool, WorkerTaskError };
