import { withPlatformAdminManagementContext } from "@/lib/api/requireManagementAuth";
import { createPendingCommandCodeAuthSession } from "@/lib/db/commandCodeAuth";

import {
  buildCommandCodeCliCallbackUrl,
  COMMAND_CODE_AUTH_TTL_MS,
  COMMAND_CODE_STUDIO_AUTH_URL,
  generateCommandCodeState,
  noStoreJson,
  stateHashFromState,
} from "../shared";

export async function POST(request: Request) {
  return withPlatformAdminManagementContext(request, async () => {
    const state = generateCommandCodeState();
    const expiresAt = new Date(Date.now() + COMMAND_CODE_AUTH_TTL_MS).toISOString();
    const stateHash = stateHashFromState(state);
    createPendingCommandCodeAuthSession({ stateHash, expiresAt });

    const callbackUrl = buildCommandCodeCliCallbackUrl();
    const authUrl = `${COMMAND_CODE_STUDIO_AUTH_URL}?callback=${encodeURIComponent(
      callbackUrl
    )}&state=${encodeURIComponent(state)}`;

    return noStoreJson({ state, authUrl, callbackUrl, expiresAt, mode: "manual" });
  });
}
