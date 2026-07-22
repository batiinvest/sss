# Capacitor iOS 빌드 방법

이 프로젝트는 기존 HTML/CSS/JS 앱을 Capacitor iOS 앱으로 감싸도록 설정되어 있습니다.

## Windows에서 준비

```powershell
npm.cmd install
npm.cmd run cap:prepare
npx.cmd cap sync ios
```

`www/`는 Capacitor에 넣을 웹 자산을 임시로 만드는 폴더라 Git에는 올리지 않습니다.

## Mac에서 iPhone 앱 빌드

Mac에는 Xcode, CocoaPods, Apple Developer 계정이 필요합니다.

```bash
npm install
npm run cap:prepare
npx cap sync ios
npx cap open ios
```

Xcode가 열리면 다음을 설정합니다.

1. `App` 타깃 선택
2. `Signing & Capabilities`에서 Team 선택
3. Bundle Identifier 확인: `com.batiinvestment.sss`
4. 실제 iPhone 또는 시뮬레이터 선택 후 Run

## 앱 업데이트 흐름

HTML/CSS/JS를 수정한 뒤 iOS 앱에 반영하려면:

```bash
npm run cap:sync
```

그 다음 Xcode에서 다시 빌드하면 됩니다.
