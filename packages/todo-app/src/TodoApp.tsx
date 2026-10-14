import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Button,
  FlatList,
  Platform,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useStore } from "zustand";
import { createTodoStore } from "./store";
import type { Filter, Todo, TodoRepository } from "./types";

const filters: { value: Filter; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "active", label: "미완료" },
  { value: "completed", label: "완료" },
];

export function TodoApp({
  repository,
  databaseName,
}: {
  repository: TodoRepository;
  databaseName: string;
}) {
  const [store] = useState(() => createTodoStore(repository));
  const state = useStore(store);
  const [settings, setSettings] = useState(false);
  const [url, setUrl] = useState(
    Platform.OS === "android" ? "http://10.0.2.2:3000" : "http://localhost:3000"
  );
  const [token, setToken] = useState("");
  useEffect(() => {
    store.getState().initialize();
  }, [store]);
  const visible = state.todos.filter(
    (todo) =>
      state.filter === "all" ||
      todo.completed === (state.filter === "completed")
  );
  const confirmDelete = (todo: Todo) =>
    Alert.alert("할 일 삭제", `“${todo.title}”을 삭제할까요?`, [
      { text: "취소", style: "cancel" },
      {
        text: "삭제",
        style: "destructive",
        onPress: () => {
          state.remove(todo.id);
        },
      },
    ]);
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <Text accessibilityRole="header" style={styles.heading}>
          Todo · {databaseName}
        </Text>
        <Button
          title={settings ? "서버 설정 닫기" : "서버 설정"}
          onPress={() => setSettings(!settings)}
        />
        {settings ? (
          <View>
            <TextInput
              accessibilityLabel="서버 URL"
              value={url}
              onChangeText={setUrl}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
            <TextInput
              accessibilityLabel="인증 토큰"
              placeholder="인증 토큰 (앱 종료 시 삭제)"
              value={token}
              onChangeText={setToken}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={styles.input}
            />
            <Text>
              동일한 서버·토큰을 두 앱에 입력하세요. 복원 시 로컬 데이터도
              보존합니다.
            </Text>
          </View>
        ) : null}
        <Button
          title={state.syncing ? "동기화 중…" : "서버 저장·복원"}
          disabled={!state.ready || state.syncing || !token.trim()}
          onPress={() => {
            state.sync({ url, token });
          }}
        />
        {state.syncMessage ? (
          <Text accessibilityRole="alert">{state.syncMessage}</Text>
        ) : null}
        {state.conflict ? (
          <View style={styles.row}>
            <Button
              title="기기 변경 유지"
              onPress={() => {
                state.sync({ url, token }, "local");
              }}
            />
            <Button
              title="서버 변경 사용"
              onPress={() => {
                Alert.alert(
                  "충돌 처리",
                  "충돌한 기기 변경을 서버 내용으로 바꿀까요?",
                  [
                    { text: "취소", style: "cancel" },
                    {
                      text: "서버 변경 사용",
                      onPress: () => {
                        state.sync({ url, token }, "server");
                      },
                    },
                  ]
                );
              }}
            />
          </View>
        ) : null}
        <Text>기기에 저장됩니다. 네트워크 없이 사용할 수 있습니다.</Text>
        <Text>
          전체 {state.todos.length} · 완료{" "}
          {state.todos.filter((todo) => todo.completed).length}
        </Text>
        {state.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {state.error}
          </Text>
        ) : null}
        {!state.ready ? (
          <View style={styles.section}>
            {state.busy ? (
              <ActivityIndicator accessibilityLabel="데이터베이스 여는 중" />
            ) : (
              <Button
                title="다시 시도"
                onPress={() => {
                  state.initialize();
                }}
              />
            )}
          </View>
        ) : (
          <>
            <TextInput
              accessibilityLabel={state.editingId ? "할 일 수정" : "새 할 일"}
              placeholder="할 일을 입력하세요"
              value={state.draft}
              onChangeText={state.setDraft}
              maxLength={200}
              style={styles.input}
              onSubmitEditing={() => {
                if (!state.busy) {
                  state.save();
                }
              }}
            />
            <View style={styles.row}>
              <Button
                title={state.editingId ? "수정 저장" : "추가"}
                disabled={state.busy || !state.draft.trim()}
                onPress={() => {
                  state.save();
                }}
              />
              {state.editingId ? (
                <Button title="수정 취소" onPress={state.cancelEdit} />
              ) : null}
              {state.busy ? (
                <ActivityIndicator accessibilityLabel="저장 중" />
              ) : null}
            </View>
            <View style={styles.row}>
              {filters.map((filter) => (
                <Button
                  key={filter.value}
                  title={filter.label}
                  disabled={state.filter === filter.value}
                  onPress={() => state.setFilter(filter.value)}
                />
              ))}
            </View>
            <FlatList
              data={visible}
              keyExtractor={(todo) => todo.id}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <Text style={styles.section}>표시할 할 일이 없습니다.</Text>
              }
              renderItem={({ item }) => (
                <View style={styles.item}>
                  <View style={styles.row}>
                    <Switch
                      accessibilityLabel={`${item.title} 완료`}
                      value={item.completed}
                      disabled={state.busy}
                      onValueChange={() => {
                        state.toggle(item);
                      }}
                    />
                    <Text
                      style={[styles.title, item.completed && styles.completed]}
                    >
                      {item.title}
                    </Text>
                  </View>
                  <View style={styles.row}>
                    <Button
                      title="수정"
                      accessibilityLabel={`${item.title} 수정`}
                      disabled={state.busy}
                      onPress={() => state.edit(item)}
                    />
                    <Button
                      title="삭제"
                      accessibilityLabel={`${item.title} 삭제`}
                      disabled={state.busy}
                      onPress={() => confirmDelete(item)}
                    />
                  </View>
                </View>
              )}
            />
          </>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: "white" },
  heading: {
    fontSize: 22,
    fontWeight: "bold",
    marginBottom: 8,
    color: "black",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginVertical: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: "#888",
    padding: 10,
    marginTop: 16,
    color: "black",
  },
  section: { marginVertical: 16 },
  item: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#888",
    paddingVertical: 8,
  },
  title: { flex: 1, color: "black" },
  completed: { textDecorationLine: "line-through" },
  error: { color: "#b00020", marginVertical: 8 },
});
