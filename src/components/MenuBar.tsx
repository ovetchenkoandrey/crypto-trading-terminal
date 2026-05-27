const ITEMS = ["Файл", "Вид", "Вставка", "Графики", "Сервис", "Окно", "Справка"];

export function MenuBar() {
  return (
    <div className="menu-bar">
      {ITEMS.map((name) => (
        <span key={name} className="mi">{name}</span>
      ))}
    </div>
  );
}
