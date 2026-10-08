import { createCloudRuntime } from "../src/cloud/runtime";

interface CloudflareEnv {
  OMNIROUTE_ENV?: string;
  OMNIROUTE_BUILD_SHA?: string;
}

const worker = {
  fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    return createCloudRuntime({ env }).fetch(request);
  },
};

export default worker;
