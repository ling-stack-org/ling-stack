import type { UpdateUserProfileRequest, UserProfileResponse } from "../types.js";
import { daemonClient } from "./client.js";

export async function getUserProfile(cwd: string): Promise<UserProfileResponse> {
  return daemonClient.getUserProfile(cwd);
}

export async function updateUserProfile(cwd: string, input: UpdateUserProfileRequest): Promise<UserProfileResponse> {
  return daemonClient.updateUserProfile(cwd, input);
}
