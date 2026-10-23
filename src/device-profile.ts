/* SPDX-License-Identifier: Apache-2.0
 * 中文：跨设备图片导出预算；默认Pico，配置不包含凭据。
 * English: bounded, device-neutral image export settings; Pico defaults contain no credentials.
 */
export interface DeviceProfile { width: number; height: number; grayLevels: number }
export const PICO_PROFILE: Readonly<DeviceProfile> = { width: 684, height: 1216, grayLevels: 16 };
export const EXPORT_IMAGE_BYTES = 2 * 1024 * 1024;
export const EXPORT_TOTAL_BYTES = 16 * 1024 * 1024;
export const EXPORT_IMAGE_PIXELS = 4 * 1024 * 1024;
export const EXPORT_IMAGE_HEIGHT = 8192;
export function deviceProfile(value: Partial<DeviceProfile> = {}): DeviceProfile {
  const profile = { width: value.width === undefined ? PICO_PROFILE.width : value.width,
    height: value.height === undefined ? PICO_PROFILE.height : value.height,
    grayLevels: value.grayLevels === undefined ? PICO_PROFILE.grayLevels : value.grayLevels };
  if (!Number.isInteger(profile.width) || profile.width < 128 || profile.width > 4096 ||
      !Number.isInteger(profile.height) || profile.height < 128 || profile.height > 4096 ||
      !Number.isInteger(profile.grayLevels) || profile.grayLevels < 2 || profile.grayLevels > 256) {
    throw new Error('设备参数无效：宽高须为128–4096的整数，灰阶须为2–256的整数。');
  }
  return profile;
}
