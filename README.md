# word-mask-org（試験用）

ワードマスキング mod（word-mask v0.7）を、組織の管理設定（appendPlugins）で「組織の mod」として読み込めるかを試すための写しです。
Team・Enterprise のアカウントでは、アプリ同梱の安全用 mod（cc-plugin-sec-default）が、自分で入れた mod を CLAUDE.md・作業フォルダー・起動時の通知・スキルなどの経路で飛ばします。
組織の mod として登録すると、これらの経路でも置き換えが効くかを確かめます。

- 対応表（実名と仮名の組）は含みません。ON/OFF は各プロジェクトの .claude/hooks/guard-config.json で決まり、マスキングを ON にしていないプロジェクトでは何もしません。

## 入れ方

組織の管理設定で enabledPlugins・extraKnownMarketplaces・appendPlugins に登録します。個人で試すときは次の1行です。

```
/plugin install word-mask-org --marketplace <owner>/<repo>
```
