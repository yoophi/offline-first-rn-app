# Offline First Todo — React Native monorepo

React Native Community CLI 앱 두 개를 pnpm workspace로 관리합니다. 두 앱은 같은 기본 React Native UI와 Zustand 상태관리를 사용하고 로컬 DB 구현만 분리합니다.

| Workspace | 앱 | 로컬 저장소 | Android applicationId | Metro |
| --- | --- | --- | --- | --- |
| `apps/watermelon` | WatermelonTodo | WatermelonDB 0.28.0 / SQLite | `com.watermelontodo` | 8081 |
| `apps/op-sqlite` | OpSqliteTodo | OP-SQLite 18.2.5 | `com.opsqlitetodo` | 8082 |
| `apps/sync-server` | Fastify API | PostgreSQL 17 | — | 3000 (API) |
| `packages/todo-app` | 공통 화면·Zustand store | DB 의존성 없음 | — | — |
| `packages/shared` | Todo 타입·Repository 계약 | — | — | — |

기존 `apps/mobile`은 `apps/watermelon`으로 이동했습니다. 앱 ID와 DB 파일이 분리되어 두 앱을 같은 기기에 설치할 수 있습니다. 네이티브 DB 의존성도 앱별로 autolinking합니다.

## 구현 범위

- Todo 추가, 제목 수정, 완료 전환, 삭제 확인, 전체/미완료/완료 필터.
- SQLite에 영속 저장하며 앱 종료 후 다시 조회합니다.
- Zustand 5는 조회 결과, 입력값, 필터, 편집 대상, 저장·초기화·오류 상태를 관리합니다. 영속 데이터의 원본은 각 DB입니다.
- DB 쓰기를 직렬화하고 commit 후 다시 조회합니다. 저장 실패 시 입력값을 유지하고 오류를 표시합니다.
- 기본 `Button`, `TextInput`, `Switch`, `FlatList`, `Alert`, `ActivityIndicator`를 사용합니다.

자체 Fastify + PostgreSQL 동기화 서버와 두 앱의 서버 저장·복원을 구현했습니다. WatermelonDB는 기본 pull/push, OP-SQLite는 영속 outbox·mutation별 ACK와 명시적 충돌 처리를 사용합니다. 서버는 단일 사용자 bearer token으로 보호하는 공유 데이터 공간입니다. 수동 동기화이며 네트워크 없이 로컬 CRUD가 가능합니다. [서버 실행·동기화 계약·복원 안내](docs/sync-server.md)를 참고하세요.

```sh
pnpm db:up
export SYNC_TOKEN="$(openssl rand -hex 24)"
pnpm run server
```

두 앱의 **서버 설정**에 URL과 같은 토큰을 입력하고 **서버 저장·복원**을 누릅니다. Android emulator URL은 `http://10.0.2.2:3000`입니다. 토큰은 앱 프로세스 종료 시 지워집니다. Drizzle은 설치하지 않았으며 서버와 OP-SQLite는 parameterized SQL을 사용합니다.

## 설치

Node.js 22.20.0, pnpm 10.34.7, React Native 0.87.1 기준입니다.

```sh
nvm use
corepack enable
pnpm install --frozen-lockfile
```

Android: JDK 17, SDK Platform 37, Build Tools 37.0.0, NDK 27.1.12297006과 `ANDROID_HOME`이 필요합니다. iOS: Xcode 및 대상 iOS 플랫폼, Ruby 3.2.3, Bundler가 필요합니다. Ruby와 Bundler가 같은 설치를 사용하도록 rbenv shim을 설정하세요.

## 실행

각 앱의 Metro와 네이티브 실행 명령을 다른 터미널에서 실행합니다.

```sh
# WatermelonDB
pnpm start:watermelon
pnpm android:watermelon
# macOS
pnpm pods:watermelon
pnpm ios:watermelon
```

```sh
# OP-SQLite — port 8082
pnpm start:op-sqlite
pnpm android:op-sqlite
# macOS
pnpm pods:op-sqlite
pnpm ios:op-sqlite
```

기존 `pnpm start`, `pnpm android`, `pnpm ios`는 WatermelonDB 앱의 별칭입니다. 두 앱의 Metro 포트를 다르게 유지하세요.

## DB 설정

- WatermelonDB는 `jsi: false`인 비동기 SQLite adapter를 사용합니다. JSI 성능 비교는 이번 구현 범위에 포함하지 않습니다.
- WatermelonDB의 decorator를 위해 해당 앱에만 Babel legacy decorators와 TypeScript 설정을 적용했습니다.
- AGP 9에서 WatermelonDB 0.28의 `BuildConfig` 참조가 컴파일되도록 해당 Android library의 생성 옵션을 활성화했습니다.
- OP-SQLite 초기화는 `PRAGMA user_version`을 읽고 버전 2까지 트랜잭션으로 마이그레이션합니다. 기존 v1 Todo를 보존하고 동기화 대기 상태로 전환합니다. 더 새로운 DB 버전은 오류를 표시하고 보존합니다.
- pnpm `node-linker=hoisted`를 사용하며 Metro와 Gradle은 workspace 루트의 의존성을 참조합니다.

## 검증

```sh
pnpm db:up
pnpm check
```

공통 store 테스트는 CRUD 결과 재조회, 새 store의 복원, 저장 실패 후 재시도, 대기 중 새 입력 보존, 초기화 재시도를 확인합니다. 각 앱에는 렌더링 테스트가 있습니다. mock 기반 테스트는 네이티브 DB 영속성 검증을 대체하지 않습니다.

2026-10-13 검증: 두 앱의 Android arm64 Debug APK 빌드, CocoaPods 설치, iOS 프로덕션 JS 번들 생성이 통과했습니다. Android 36 arm64 테스트 에뮬레이터에서 두 앱 모두 추가·수정·완료·삭제와 강제 종료 후 제목/완료 상태 복원을 확인했습니다. 동기화 추가 후 린트·타입 검사와 테스트 22개(실제 PostgreSQL 서버 8개, SQLite repository 6개, store 6개, 앱 렌더링 2개)가 통과했습니다. Android에서 두 앱 간 서버 저장·복원, 양쪽 로컬 DB 초기화 후 서버 복원, 삭제 전파도 확인했습니다. iOS 네이티브 실행은 Xcode에 iOS 26.2 플랫폼이 없어 검증하지 못했습니다.

에뮬레이터에 두 APK가 설치되어 있고 Metro 두 개가 실행 중이면 아래 스크립트로 CRUD와 강제 종료 후 영속성을 검증할 수 있습니다. 물리 기기에는 실행되지 않으며 생성한 테스트 Todo만 삭제합니다.

```sh
python3 scripts/verify-android.py emulator-5580
```

## Lenovo 기기 설치

2026-10-13 Lenovo TB-9707F (Android 12, arm64)에 두 앱을 설치하고 DB 초기화와 Todo 화면 실행을 확인했습니다. 설치한 APK는 JavaScript 번들이 포함된 release variant이며 Metro 없이 실행됩니다. 현재 프로젝트의 개발용 키로 서명했으며 스토어 배포용 서명은 별도 구성해야 합니다.

- WatermelonTodo: `apps/watermelon/android/app/build/outputs/apk/release/app-release.apk`
- OpSqliteTodo: `apps/op-sqlite/android/app/build/outputs/apk/release/app-release.apk`

각 앱의 `android` 디렉터리에서 `./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a`로 다시 빌드할 수 있습니다. 실제 기기의 서버 동기화에는 접근 가능한 HTTPS 서버 URL과 인증 토큰을 입력하세요. 기본 `10.0.2.2` 주소는 Android emulator 전용이며, release variant는 HTTP cleartext 연결을 허용하지 않습니다.

## 설계 문서

- [기술 스택 비교 및 추천](docs/technology-stack-recommendation.md)
- [OP-SQLite 동기화 설계 제안](docs/local-database-op-sqlite.md)

위 두 문서는 설계 검토 기록입니다. 현재 실행·동기화 계약과 운영 제한은 [자체 동기화 서버](docs/sync-server.md)를 기준으로 확인합니다.
