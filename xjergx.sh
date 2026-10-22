#!/bin/bash
STATE_FILE=".xjergx/backlog.json"
AGENTS_DIR=".xjergx/agents"
BASE_DIR=".xjergx"

echo "Init xjergx-harness..."

# ==========================================
# CONFIGURACIÓN DEL MODO DE EJECUCIÓN
# ==========================================

EXECUTION_MODE="interactive"

# PREFLIGHT MODES DESCRIPTION:
# --mode interactive (Default):
  # - Comportamiento: "Human-in-the-Loop" estricto.
  # - Cuándo usarlo: Para lógica de negocio central, bases de datos o características complejas.
  # - Flujo: El script se detiene después de CADA artefacto. El designer te pregunta cosas, el spec-writer te muestra el borrador para que lo apruebes, y el code-writer espera tu OK antes de hacer el commit.

# --mode yolo (Totalmente Autónomo) YO NO USARIA - PELIGRO:

  # - Comportamiento: Cero intervenciones. El líder asume el mando completo.
  # - Cuándo usarlo: Para tareas repetitivas, boilerplates, refactorizaciones simples, o componentes UI aislados (ej. "Crea un botón rojo que diga 'Peligro'").
  # - Flujo: El designer asume la mejor arquitectura sin preguntarte. Si algo falla en el code-review, lo reintenta automáticamente hasta 3 veces y, si pasa, hace el commit directo.

# --mode dry-run (Simulación):

  # - Comportamiento: Los agentes generan los archivos .md de contexto, arquitectura y spec, pero se detienen justo antes de escribir código.
  # - Cuándo usarlo: Cuando solo quieres que la IA te documente un problema o te arme el plan, pero tú quieres escribir el código a mano.

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --yolo) EXECUTION_MODE="yolo"; shift ;;
        --dry-run) EXECUTION_MODE="dry-run"; shift ;;
        --interactive) EXECUTION_MODE="interactive"; shift ;;
        *) echo "⚠️ Argumento desconocido: $1"; shift ;;
    esac
done

echo "Harness execution mode: $EXECUTION_MODE"

# ==========================================
# PREFLIGHT PHASE (WORKSPACE)
# ==========================================

#  NOTE: 1. Buscar todos los directorios que sean repositorios Git (buscando carpetas .git en el primer nivel)
#  find . -maxdepth 2 -name ".git" -type d busca las carpetas ocultas de git.
# sed 's/\/.git//' limpia la ruta para obtener solo el nombre de la carpeta del repo.

REPOS=$(find . -maxdepth 2 -name ".git" -type d | sed 's/\/.git//')

if [ -z "$REPOS" ]; then
    echo "❌ ERROR: Not found any git repository in this workspace."
    exit 1
fi

# NOTE: 2. Iterar sobre cada repositorio encontrado y validar su estado (Working tree limpio)
for REPO in $REPOS; do
    # NOTE: 'git -C "$REPO"' para ejecutar el comando git dentro de esa carpeta específica
    if ! git -C "$REPO" diff-index --quiet HEAD -- 2>/dev/null; then
        echo "❌ ERROR DE PREFLIGHT: Tienes cambios sin confirmar en el repositorio: $REPO"
        echo "Por favor haz 'git commit' o 'git stash' en esa carpeta antes de ejecutar el arnés."
        exit 1
    fi
done

#  NOTE: 3. Validar dependencias
if ! command -v jq &> /dev/null; then
    echo "❌ ERROR: Se requiere la utilidad 'jq' instalada en tu sistema."
    exit 1
fi

# 1. NOTE: SI EL ARCHIVO NO EXISTE, CREAR LA CARPETA Y EL ARCHIVO
if [ ! -f "$STATE_FILE" ]; then
    echo "backlog.json not found. Creating a new one..."
    
    mkdir -p "$BASE_DIR"
    
    echo '{
  "tasks": []
}' > "$STATE_FILE"
    
    echo "Created successfully $STATE_FILE."
    echo "Add tasks to the backlog."
    exit 0
fi

# 2. NOTE: BUSCAR LA PRIMERA TAREA QUE NO ESTÉ COMPLETADA.
# Se requiere jq para buscar las tareas aun no terminadas en el json
ACTIVE_TASK=$(jq -c '.tasks[] | select(.status != "completed")' "$STATE_FILE" | head -n 1)

if [ -z "$ACTIVE_TASK" ]; then
    echo "Todas las tareas están en estado 'completed'. No hay nada pendiente."
    exit 0
fi

# 3. NOTE: EXTRAER DATOS DE LA TAREA ACTIVA
TASK_ID=$(echo $ACTIVE_TASK | jq -r '.id')
TASK_DESC=$(echo $ACTIVE_TASK | jq -r '.description')
TASK_STATUS=$(echo $ACTIVE_TASK | jq -r '.status')
TASK_TYPE=$(echo $ACTIVE_TASK | jq -r '.type // "feature"') # Si no existe, asume 'feature'

echo "Processing $TASK_ID: $TASK_DESC"
echo "Actual status: $TASK_STATUS"

# 4. NOTE: ENRUTAMIENTO DE ESTADOS A AGENTES Y HUMAN-IN-THE-LOOP
case $TASK_STATUS in
    "pending")
        if [ "$TASK_TYPE" == "hotfix" ]; then
            echo "⚡ FAST-TRACK DETECTADO: Saltando SDD."
            AGENT_FILES="$AGENTS_DIR/xjergx-hotfixer.md"
            NEXT_STATUS="archiving"
        else
            echo "🔍 Fase de Diseño: Invocando al Explorer, Designer y Spec-Writer..."
            AGENT_FILES="$AGENTS_DIR/xjergx-explore.md, $AGENTS_DIR/xjergx-spec-designer.md, $AGENTS_DIR/xjergx-spec-writer.md"
            NEXT_STATUS="spec_ready"
        fi
        ;;
        
    "spec_ready")
        # ==========================================
        # 🛑 HUMAN-IN-THE-LOOP (HITL) CHECK
        # ==========================================
        if [ "$EXECUTION_MODE" == "interactive" ]; then
            echo ""
            echo "⚠️  ATENCIÓN: La fase de diseño ha terminado."
            echo "📄 Por favor, abre y lee el archivo (.xjergx/specs/$TASK_ID-spec.md)."
            echo ""
            read -p "❓ ¿Apruebas el documento OpenSpec para comenzar a programar? (s/n): " confirm
            
            if [[ "$confirm" != "s" && "$confirm" != "S" ]]; then
                echo "🛑 Ejecución pausada por el usuario."
                exit 0
            fi
            echo "✅ Spec aprobado. El estado cambiará a 'coding'."
            echo ""
        fi

        # Preparamos los agentes para codificar y pasamos el estado a 'coding'
        # Así, si se interrumpe, sabrá dónde retomar.
        echo "💻 Iniciando Fase de Ejecución: Invocando al Code-Writer y Code-Reviewer..."
        AGENT_FILES="$AGENTS_DIR/xjergx-code-writer.md y $AGENTS_DIR/xjergx-code-review.md"
        NEXT_STATUS="coding" 
        ;;

    "coding")
        # ==========================================
        # 🚧 RETOMAR SESIÓN DE CÓDIGO
        # ==========================================
        echo "🚧 Retomando Fase de Ejecución (Coding & Audit)..."
        echo "💻 Invocando al Code-Writer y Code-Reviewer..."
        AGENT_FILES="$AGENTS_DIR/xjergx-code-writer.md y $AGENTS_DIR/xjergx-code-review.md"
        
        # Una vez que el código pasa la auditoría con éxito, pasamos a archivar
        NEXT_STATUS="archiving"
        ;;

    "archiving")
        # ==========================================
        # 🧠 FASE DE MEMORIA Y APRENDIZAJE
        # ==========================================
        echo "🧠 Fase de Memoria: Guardando aprendizajes en el Engram..."
        AGENT_FILES="$AGENTS_DIR/xjergx-memory-archivist.md"
        NEXT_STATUS="completed"
        ;;
        
    *)
        echo "❌ Estado no válido: $TASK_STATUS"
        exit 1
        ;;
esac

# 5. NOTE: SIMULACIÓN DE LLAMADA AL LÍDER (Aquí iría tu comando a la IA)
echo "El xjergx-leader está leyendo los archivos: $AGENT_FILES"
sleep 2 # Simulando el tiempo de procesamiento de la IA

# 6. NOTE: ACTUALIZAR EL ESTADO DE LA TAREA EN EL JSON
# Buscamos la tarea por su ID y actualizamos su status al siguiente nivel
jq "( .tasks[] | select(.id == \"$TASK_ID\") | .status ) = \"$NEXT_STATUS\"" $STATE_FILE > tmp.json && mv tmp.json $STATE_FILE

echo "$TASK_ID ha sido actualizado al estado: $NEXT_STATUS"
