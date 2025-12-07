/**
 * ESP32 DevKitC Pin Utilities
 * Pin specification and validation for ESP32 development
 */

export interface PinSpec {
  number: number;
  name: string;
  altNames?: string[];
  available: boolean;
  digitalIn: boolean;
  digitalOut: boolean;
  analogIn: boolean;
  dac: boolean;
  touch: boolean;
  pwm: boolean;
  inputOnly: boolean;
  strapping?: boolean;
  notes?: string;
}

export interface PinWarning {
  pin: number;
  type: 'unavailable' | 'input_only' | 'strapping' | 'reserved';
  severity: 'error' | 'warning' | 'info';
  message: string;
  suggestion?: string;
}

export interface PinUsageEntry {
  pin: number;
  mode?: string;
  file: string;
  line: number;
  raw: string;
  pinSpec?: PinSpec;
  warnings: PinWarning[];
}

export interface PinUsageSummary {
  total: number;
  uniquePins: number[];
  errors: number;
  warnings: number;
  usages: PinUsageEntry[];
}

// ESP32 DevKitC Pin Specification
export const DEVKITC_PIN_SPEC: PinSpec[] = [
  { number: 0, name: 'IO0', altNames: ['GPIO0', 'BOOT', 'ADC2_CH1', 'TOUCH1'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false, strapping: true, notes: 'Boot strapping pin (keep HIGH for normal boot). Also supports touch sensing and ADC2.' },
  { number: 1, name: 'IO1', altNames: ['GPIO1', 'TX0'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false, notes: 'UART0 TX (USB serial). Avoid repurposing if console is required.' },
  { number: 2, name: 'IO2', altNames: ['GPIO2', 'ADC2_CH2', 'TOUCH2', 'LED_BUILTIN'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false, strapping: true, notes: 'On-board LED, boot strapping pin.' },
  { number: 3, name: 'IO3', altNames: ['GPIO3', 'RX0'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false, notes: 'UART0 RX (USB serial).' },
  { number: 4, name: 'IO4', altNames: ['GPIO4', 'ADC2_CH0', 'TOUCH0'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false, strapping: true },
  { number: 5, name: 'IO5', altNames: ['GPIO5', 'VSPI_CS'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: false, pwm: true, inputOnly: false, strapping: true, notes: 'Default VSPI CS, boot strapping pin.' },
  { number: 6, name: 'IO6', altNames: ['GPIO6'], available: false, digitalIn: false, digitalOut: false, analogIn: false, dac: false, touch: false, pwm: false, inputOnly: false, notes: 'Connected to SPI flash—do not use.' },
  { number: 7, name: 'IO7', altNames: ['GPIO7'], available: false, digitalIn: false, digitalOut: false, analogIn: false, dac: false, touch: false, pwm: false, inputOnly: false, notes: 'Connected to SPI flash—do not use.' },
  { number: 8, name: 'IO8', altNames: ['GPIO8'], available: false, digitalIn: false, digitalOut: false, analogIn: false, dac: false, touch: false, pwm: false, inputOnly: false, notes: 'Connected to SPI flash—do not use.' },
  { number: 9, name: 'IO9', altNames: ['GPIO9'], available: false, digitalIn: false, digitalOut: false, analogIn: false, dac: false, touch: false, pwm: false, inputOnly: false, notes: 'Connected to SPI flash—do not use.' },
  { number: 10, name: 'IO10', altNames: ['GPIO10'], available: false, digitalIn: false, digitalOut: false, analogIn: false, dac: false, touch: false, pwm: false, inputOnly: false, notes: 'Connected to SPI flash—do not use.' },
  { number: 11, name: 'IO11', altNames: ['GPIO11'], available: false, digitalIn: false, digitalOut: false, analogIn: false, dac: false, touch: false, pwm: false, inputOnly: false, notes: 'Connected to SPI flash—do not use.' },
  { number: 12, name: 'IO12', altNames: ['GPIO12', 'ADC2_CH5', 'TOUCH5'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false, strapping: true, notes: 'MTDI strapping pin (LOW to enter download mode).' },
  { number: 13, name: 'IO13', altNames: ['GPIO13', 'ADC2_CH4', 'TOUCH4'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false, strapping: true },
  { number: 14, name: 'IO14', altNames: ['GPIO14', 'ADC2_CH6', 'TOUCH6'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false, strapping: true },
  { number: 15, name: 'IO15', altNames: ['GPIO15', 'ADC2_CH3', 'TOUCH3'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false, strapping: true, notes: 'MTDO strapping pin.' },
  { number: 16, name: 'IO16', altNames: ['GPIO16', 'U2RXD'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false },
  { number: 17, name: 'IO17', altNames: ['GPIO17', 'U2TXD'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false },
  { number: 18, name: 'IO18', altNames: ['GPIO18', 'VSPI_CLK'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false },
  { number: 19, name: 'IO19', altNames: ['GPIO19', 'VSPI_MISO'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false },
  { number: 21, name: 'IO21', altNames: ['GPIO21', 'SDA'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false, notes: 'Default I2C SDA.' },
  { number: 22, name: 'IO22', altNames: ['GPIO22', 'SCL'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false, notes: 'Default I2C SCL.' },
  { number: 23, name: 'IO23', altNames: ['GPIO23', 'VSPI_MOSI'], available: true, digitalIn: true, digitalOut: true, analogIn: false, dac: false, touch: false, pwm: true, inputOnly: false },
  { number: 25, name: 'IO25', altNames: ['GPIO25', 'DAC1', 'ADC2_CH8'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: true, touch: false, pwm: true, inputOnly: false, notes: 'DAC channel 1.' },
  { number: 26, name: 'IO26', altNames: ['GPIO26', 'DAC2', 'ADC2_CH9'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: true, touch: false, pwm: true, inputOnly: false, notes: 'DAC channel 2.' },
  { number: 27, name: 'IO27', altNames: ['GPIO27', 'ADC2_CH7', 'TOUCH7'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false },
  { number: 32, name: 'IO32', altNames: ['GPIO32', 'ADC1_CH4', 'TOUCH9'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false },
  { number: 33, name: 'IO33', altNames: ['GPIO33', 'ADC1_CH5', 'TOUCH8'], available: true, digitalIn: true, digitalOut: true, analogIn: true, dac: false, touch: true, pwm: true, inputOnly: false },
  { number: 34, name: 'IO34', altNames: ['GPIO34', 'ADC1_CH6'], available: true, digitalIn: true, digitalOut: false, analogIn: true, dac: false, touch: false, pwm: false, inputOnly: true, notes: 'Input-only (no output driver).' },
  { number: 35, name: 'IO35', altNames: ['GPIO35', 'ADC1_CH7'], available: true, digitalIn: true, digitalOut: false, analogIn: true, dac: false, touch: false, pwm: false, inputOnly: true, notes: 'Input-only (no output driver).' },
  { number: 36, name: 'IO36', altNames: ['GPIO36', 'SVP', 'ADC1_CH0'], available: true, digitalIn: true, digitalOut: false, analogIn: true, dac: false, touch: false, pwm: false, inputOnly: true, notes: 'Sensor VP, input-only.' },
  { number: 39, name: 'IO39', altNames: ['GPIO39', 'SVN', 'ADC1_CH3'], available: true, digitalIn: true, digitalOut: false, analogIn: true, dac: false, touch: false, pwm: false, inputOnly: true, notes: 'Sensor VN, input-only.' },
];

// Base pin aliases
const BASE_PIN_ALIAS: Record<string, number> = {
  LED_BUILTIN: 2,
  LED0: 2,
  TX: 1,
  TX0: 1,
  RX: 3,
  RX0: 3,
  SDA: 21,
  SCL: 22,
  MISO: 19,
  MOSI: 23,
  SCK: 18,
  SS: 5,
  SPI_CLK: 18,
  SPI_MISO: 19,
  SPI_MOSI: 23,
  SPI_CS: 5,
};

// Build full alias map
export const PIN_ALIAS: Record<string, number> = {};

for (const [key, value] of Object.entries(BASE_PIN_ALIAS)) {
  PIN_ALIAS[key.toUpperCase()] = value;
}

for (const spec of DEVKITC_PIN_SPEC) {
  const baseKey = `GPIO${spec.number}`;
  PIN_ALIAS[baseKey.toUpperCase()] = spec.number;
  PIN_ALIAS[`IO${spec.number}`.toUpperCase()] = spec.number;
  if (spec.altNames) {
    for (const alt of spec.altNames) {
      PIN_ALIAS[alt.toUpperCase()] = spec.number;
    }
  }
}

// Pin spec lookup map
export const PIN_SPEC_MAP = new Map<number, PinSpec>(
  DEVKITC_PIN_SPEC.map((pin) => [pin.number, pin] as const)
);

/**
 * Resolve pin identifier to pin number
 */
export function resolvePinNumber(identifier: string): number | null {
  const trimmed = identifier.trim();
  
  // Direct number
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 0 && num <= 39) {
    return num;
  }
  
  // Alias lookup
  const upper = trimmed.toUpperCase();
  if (upper in PIN_ALIAS) {
    return PIN_ALIAS[upper];
  }
  
  return null;
}

/**
 * Get pin spec by number
 */
export function getPinSpec(pinNumber: number): PinSpec | undefined {
  return PIN_SPEC_MAP.get(pinNumber);
}

/**
 * Validate pin for output usage
 */
export function validatePinForOutput(pinNumber: number): PinWarning[] {
  const warnings: PinWarning[] = [];
  const spec = getPinSpec(pinNumber);
  
  if (!spec) {
    warnings.push({
      pin: pinNumber,
      type: 'unavailable',
      severity: 'warning',
      message: `Pin ${pinNumber} is not a standard ESP32 pin`,
    });
    return warnings;
  }
  
  if (!spec.available) {
    warnings.push({
      pin: pinNumber,
      type: 'reserved',
      severity: 'error',
      message: `Pin ${pinNumber} (${spec.name}) is reserved: ${spec.notes || 'Do not use'}`,
    });
  }
  
  if (spec.inputOnly) {
    warnings.push({
      pin: pinNumber,
      type: 'input_only',
      severity: 'error',
      message: `Pin ${pinNumber} (${spec.name}) is input-only and cannot be used for output`,
      suggestion: 'Use a different GPIO pin for output',
    });
  }
  
  if (spec.strapping) {
    warnings.push({
      pin: pinNumber,
      type: 'strapping',
      severity: 'warning',
      message: `Pin ${pinNumber} (${spec.name}) is a strapping pin - may affect boot behavior`,
      suggestion: spec.notes,
    });
  }
  
  return warnings;
}

/**
 * Validate pin for input usage
 */
export function validatePinForInput(pinNumber: number): PinWarning[] {
  const warnings: PinWarning[] = [];
  const spec = getPinSpec(pinNumber);
  
  if (!spec) {
    warnings.push({
      pin: pinNumber,
      type: 'unavailable',
      severity: 'warning',
      message: `Pin ${pinNumber} is not a standard ESP32 pin`,
    });
    return warnings;
  }
  
  if (!spec.available) {
    warnings.push({
      pin: pinNumber,
      type: 'reserved',
      severity: 'error',
      message: `Pin ${pinNumber} (${spec.name}) is reserved: ${spec.notes || 'Do not use'}`,
    });
  }
  
  if (!spec.digitalIn) {
    warnings.push({
      pin: pinNumber,
      type: 'unavailable',
      severity: 'error',
      message: `Pin ${pinNumber} (${spec.name}) does not support digital input`,
    });
  }
  
  return warnings;
}

/**
 * Get formatted pin spec as string
 */
export function formatPinSpec(): string {
  const lines: string[] = ['ESP32-DevKitC Pin Specification:', ''];
  
  for (const spec of DEVKITC_PIN_SPEC) {
    const features: string[] = [];
    if (spec.digitalIn) features.push('DI');
    if (spec.digitalOut) features.push('DO');
    if (spec.analogIn) features.push('ADC');
    if (spec.dac) features.push('DAC');
    if (spec.touch) features.push('Touch');
    if (spec.pwm) features.push('PWM');
    
    const status = spec.available ? '✓' : '✗';
    const flags: string[] = [];
    if (spec.inputOnly) flags.push('INPUT_ONLY');
    if (spec.strapping) flags.push('STRAPPING');
    
    lines.push(
      `${status} ${spec.name.padEnd(6)} [${features.join(',')}]${flags.length ? ' ' + flags.join(' ') : ''}${spec.notes ? ' - ' + spec.notes : ''}`
    );
  }
  
  return lines.join('\n');
}

