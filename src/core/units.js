// Unit conversions. Data is authored in baseball units (mph, rpm, ft, in);
// physics runs in SI (m, s, kg, rad/s). Convert once at the boundary.

export const MPH = 0.44704;               // m/s per mph
export const FT = 0.3048;                 // m per ft
export const IN = 0.0254;                 // m per in
export const RPM = (2 * Math.PI) / 60;    // rad/s per rpm
export const DEG = Math.PI / 180;         // rad per degree
export const OZ = 0.028349523125;         // kg per oz

export const mphToMps = (mph) => mph * MPH;
export const mpsToMph = (mps) => mps / MPH;
export const ftToM = (ft) => ft * FT;
export const mToFt = (m) => m / FT;
export const inToM = (inches) => inches * IN;
export const mToIn = (m) => m / IN;
export const rpmToRadS = (rpm) => rpm * RPM;
export const radSToRpm = (radS) => radS / RPM;
export const degToRad = (deg) => deg * DEG;
export const radToDeg = (rad) => rad / DEG;
